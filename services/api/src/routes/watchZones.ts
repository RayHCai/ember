import type { FastifyInstance } from 'fastify';
import { WATCH_ZONES_PATH } from '@ember/contracts';
import type {
    CreateWatchZoneRequest,
    LatLng,
    UpdateWatchZoneRequest,
    WatchZone,
    WatchZoneId,
} from '@ember/contracts';
import type { Prisma, WatchZone as WatchZoneRow } from '../generated/prisma/client.js';
import { operatorOf } from '../auth.js';
import type { Db } from '../db.js';
import { notFound, orMissing } from '../http.js';
import { limit, ring, uuid } from '../schemas.js';
import type { Surroundings } from '../surroundings.js';

const HOUR_MS = 3_600_000;
const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
const region = { type: ['string', 'null'], maxLength: 200 } as const;
const scanEveryHours = { type: ['integer', 'null'], minimum: 1, maximum: 168 } as const;
const params = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;
const one = `${WATCH_ZONES_PATH}/:zoneId`;

type ZoneParams = { zoneId: string };

export function watchZoneWire(row: WatchZoneRow): WatchZone {
    return {
        id: row.id as WatchZoneId,
        name: row.name,
        region: row.region,
        boundary: row.boundary as LatLng[],
        scanEveryHours: row.scanEveryHours,
        nextScanAt: row.nextScanAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export function watchZoneRoutes(
    app: FastifyInstance,
    { db, surroundings }: { db: Db; surroundings: Surroundings },
) {
    app.post<{ Body: CreateWatchZoneRequest }>(
        WATCH_ZONES_PATH,
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['name', 'boundary'],
                    additionalProperties: false,
                    properties: { name, boundary: ring, region },
                },
            },
        },
        async (req, reply) => {
            const zone = req.body;
            const row = await db.watchZone.create({
                data: {
                    name: zone.name,
                    boundary: zone.boundary,
                    region: zone.region ?? null,
                    createdBy: operatorOf(req)?.operator.id ?? null,
                },
            });
            surroundings.refreshLater(row.id, zone.boundary);
            return reply.code(201).send(watchZoneWire(row));
        },
    );

    app.get<{ Querystring: { limit: number } }>(
        WATCH_ZONES_PATH,
        { schema: { querystring: { type: 'object', properties: { limit } } } },
        async (req, reply) => {
            const rows = await db.watchZone.findMany({
                orderBy: { createdAt: 'desc' },
                take: req.query.limit,
            });
            return reply.send(rows.map(watchZoneWire));
        },
    );

    app.get<{ Params: ZoneParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await db.watchZone.findUnique({ where: { id: req.params.zoneId } });
        return row ? watchZoneWire(row) : notFound(reply, `watch zone ${req.params.zoneId}`);
    });

    app.patch<{ Params: ZoneParams; Body: UpdateWatchZoneRequest }>(
        one,
        {
            schema: {
                params,
                body: {
                    type: 'object',
                    minProperties: 1,
                    additionalProperties: false,
                    properties: { name, boundary: ring, region, scanEveryHours },
                },
            },
        },
        async (req, reply) => {
            const { scanEveryHours: hours, ...fields } = req.body;
            const data: Prisma.WatchZoneUpdateInput = fields;
            if (hours !== undefined) {
                data.scanEveryHours = hours;
                data.nextScanAt = hours === null ? null : new Date(Date.now() + hours * HOUR_MS);
            }
            const row = await orMissing(
                db.watchZone.update({ where: { id: req.params.zoneId }, data }),
            );
            if (!row) return notFound(reply, `watch zone ${req.params.zoneId}`);
            if (fields.boundary !== undefined) surroundings.refreshLater(row.id, fields.boundary);
            return watchZoneWire(row);
        },
    );

    // Everything it owns goes with it; edge servers and detections stay, unzoned.
    app.delete<{ Params: ZoneParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await orMissing(db.watchZone.delete({ where: { id: req.params.zoneId } }));
        return row ? reply.code(204).send() : notFound(reply, `watch zone ${req.params.zoneId}`);
    });
}
