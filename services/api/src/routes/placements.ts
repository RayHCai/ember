import type { FastifyInstance } from 'fastify';
import { PLACEMENTS_PATH, ZONE_PLACEMENTS_PATH } from '@ember/contracts';
import type {
    AssignPlacementRequest,
    CreatePlacementRequest,
    EdgeServerPlacement,
    LatLng,
    SuggestPlacementsRequest,
    SuggestPlacementsResult,
    UpdatePlacementRequest,
    WatchZoneId,
} from '@ember/contracts';
import type { EdgeServerPlacement as PlacementRow } from '../generated/prisma/client.js';
import type { Db } from '../db.js';
import type { EdgeManager } from '../edgeManager.js';
import { centroid, siteName, suggestSites, type Circle } from '../geo.js';
import { notFound, optionalBody, orMissing } from '../http.js';
import { deviceId, latLng, uuid } from '../schemas.js';
import { edgeServerWire } from './edgeServers.js';

const DEFAULT_RADIUS_M = 500;
const DEFAULT_TARGET_COVERAGE = 0.92;

const radiusM = { type: 'number', exclusiveMinimum: 0, maximum: 20_000 } as const;
const name = { type: 'string', minLength: 1, maxLength: 120 } as const;
const zoneParams = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;
const placementParams = {
    type: 'object',
    required: ['placementId'],
    properties: { placementId: uuid },
} as const;
const one = `${PLACEMENTS_PATH}/:placementId`;

type ZoneParams = { zoneId: string };
type PlacementParams = { placementId: string };

export function placementWire(row: PlacementRow): EdgeServerPlacement {
    return {
        placementId: row.id,
        zoneId: row.zoneId as WatchZoneId,
        name: row.name,
        location: { lat: row.lat, lng: row.lng },
        connectivityRadiusM: row.connectivityRadiusM,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** The zone's edge servers that are deployed: a position and a radius. */
async function deployedCircles(db: Db, zoneId: string): Promise<Circle[]> {
    const edges = await db.edgeServer.findMany({
        where: {
            zoneId,
            lat: { not: null },
            lng: { not: null },
            connectivityRadiusM: { not: null },
        },
        select: { lat: true, lng: true, connectivityRadiusM: true },
    });
    return edges.flatMap((e) =>
        e.lat === null || e.lng === null || e.connectivityRadiusM === null
            ? []
            : [{ center: { lat: e.lat, lng: e.lng }, radiusM: e.connectivityRadiusM }],
    );
}

async function edgeServerNames(db: Db, zoneId: string): Promise<string[]> {
    const edges = await db.edgeServer.findMany({
        where: { zoneId, name: { not: null } },
        select: { name: true },
    });
    return edges.flatMap((e) => (e.name === null ? [] : [e.name]));
}

export function placementRoutes(
    app: FastifyInstance,
    { db, edgeManager }: { db: Db; edgeManager: EdgeManager | null },
) {
    const zoneOf = (zoneId: string) =>
        db.watchZone.findUnique({ where: { id: zoneId }, select: { id: true, boundary: true } });

    app.get<{ Params: ZoneParams }>(
        ZONE_PLACEMENTS_PATH,
        { schema: { params: zoneParams } },
        async (req, reply) => {
            const rows = await db.edgeServerPlacement.findMany({
                where: { zoneId: req.params.zoneId },
                orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
            });
            return reply.send(rows.map(placementWire));
        },
    );

    app.post<{ Params: ZoneParams; Body: CreatePlacementRequest }>(
        ZONE_PLACEMENTS_PATH,
        {
            schema: {
                params: zoneParams,
                body: {
                    type: 'object',
                    required: ['location'],
                    additionalProperties: false,
                    properties: { location: latLng, connectivityRadiusM: radiusM, name },
                },
            },
        },
        async (req, reply) => {
            const zone = await zoneOf(req.params.zoneId);
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            const { location, connectivityRadiusM = DEFAULT_RADIUS_M } = req.body;
            let placementName = req.body.name;
            if (placementName === undefined) {
                const placements = await db.edgeServerPlacement.findMany({
                    where: { zoneId: zone.id },
                    select: { name: true },
                });
                const taken = new Set([
                    ...(await edgeServerNames(db, zone.id)),
                    ...placements.map((p) => p.name),
                ]);
                placementName = siteName(centroid(zone.boundary as LatLng[]), location, taken);
            }
            const row = await db.edgeServerPlacement.create({
                data: {
                    zoneId: zone.id,
                    name: placementName,
                    lat: location.lat,
                    lng: location.lng,
                    connectivityRadiusM,
                },
            });
            return reply.code(201).send(placementWire(row));
        },
    );

    // Replaces the zone's placements: suggestions are a plan, not a pile.
    app.post<{ Params: ZoneParams; Body: SuggestPlacementsRequest }>(
        `${ZONE_PLACEMENTS_PATH}/suggest`,
        {
            preValidation: optionalBody,
            schema: {
                params: zoneParams,
                body: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        targetCoverage: { type: 'number', minimum: 0, maximum: 1 },
                        connectivityRadiusM: radiusM,
                    },
                },
            },
        },
        async (req, reply) => {
            const zone = await zoneOf(req.params.zoneId);
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            const radius = req.body.connectivityRadiusM ?? DEFAULT_RADIUS_M;
            const boundary = zone.boundary as LatLng[];
            const suggestion = suggestSites(boundary, await deployedCircles(db, zone.id), {
                targetCoverage: req.body.targetCoverage ?? DEFAULT_TARGET_COVERAGE,
                radiusM: radius,
            });
            const center = centroid(boundary);
            const taken = new Set(await edgeServerNames(db, zone.id));
            const data = suggestion.sites.map((site) => ({
                zoneId: zone.id,
                name: siteName(center, site, taken),
                lat: site.lat,
                lng: site.lng,
                connectivityRadiusM: radius,
            }));
            const rows = await db.$transaction(async (tx) => {
                await tx.edgeServerPlacement.deleteMany({ where: { zoneId: zone.id } });
                return tx.edgeServerPlacement.createManyAndReturn({ data });
            });
            const order = new Map(data.map((d, i) => [d.name, i]));
            const result: SuggestPlacementsResult = {
                placements: rows
                    .toSorted((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
                    .map(placementWire),
                coverage: suggestion.coverage,
                projectedCoverage: suggestion.projectedCoverage,
            };
            return result;
        },
    );

    app.delete<{ Params: ZoneParams }>(
        ZONE_PLACEMENTS_PATH,
        { schema: { params: zoneParams } },
        async (req, reply) => {
            await db.edgeServerPlacement.deleteMany({ where: { zoneId: req.params.zoneId } });
            return reply.code(204).send();
        },
    );

    app.patch<{ Params: PlacementParams; Body: UpdatePlacementRequest }>(
        one,
        {
            schema: {
                params: placementParams,
                body: {
                    type: 'object',
                    minProperties: 1,
                    additionalProperties: false,
                    properties: { name, location: latLng, connectivityRadiusM: radiusM },
                },
            },
        },
        async (req, reply) => {
            const { location, ...fields } = req.body;
            const row = await orMissing(
                db.edgeServerPlacement.update({
                    where: { id: req.params.placementId },
                    data: { ...fields, ...location },
                }),
            );
            return row
                ? placementWire(row)
                : notFound(reply, `placement ${req.params.placementId}`);
        },
    );

    app.delete<{ Params: PlacementParams }>(
        one,
        { schema: { params: placementParams } },
        async (req, reply) => {
            const row = await orMissing(
                db.edgeServerPlacement.delete({ where: { id: req.params.placementId } }),
            );
            return row
                ? reply.code(204).send()
                : notFound(reply, `placement ${req.params.placementId}`);
        },
    );

    // The placement becomes the edge server: its zone, name, position and radius move over.
    app.post<{ Params: PlacementParams; Body: AssignPlacementRequest }>(
        `${one}/assign`,
        {
            schema: {
                params: placementParams,
                body: {
                    type: 'object',
                    required: ['edgeServerId'],
                    additionalProperties: false,
                    properties: { edgeServerId: deviceId },
                },
            },
        },
        async (req, reply) => {
            const { placementId } = req.params;
            const { edgeServerId } = req.body;
            const assigned = await db.$transaction(async (tx) => {
                const placement = await tx.edgeServerPlacement.findUnique({
                    where: { id: placementId },
                });
                if (!placement) return `placement ${placementId}`;
                const edge = await tx.edgeServer.findUnique({
                    where: { id: edgeServerId },
                    select: { id: true },
                });
                if (!edge) return `edge server ${edgeServerId}`;
                const row = await tx.edgeServer.update({
                    where: { id: edgeServerId },
                    data: {
                        zoneId: placement.zoneId,
                        name: placement.name,
                        lat: placement.lat,
                        lng: placement.lng,
                        connectivityRadiusM: placement.connectivityRadiusM,
                    },
                });
                await tx.edgeServerPlacement.delete({ where: { id: placementId } });
                return row;
            });
            if (typeof assigned === 'string') return notFound(reply, assigned);
            return edgeServerWire(assigned, edgeManager ? await edgeManager.live() : null);
        },
    );
}
