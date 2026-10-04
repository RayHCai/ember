import type { FastifyInstance } from 'fastify';
import { API_EDGE_SERVERS_PATH } from '@ember/contracts';
import type {
    EdgeServer,
    EdgeServerStatus,
    PutEdgeServerRequest,
    UpdateEdgeServerRequest,
    WatchZoneId,
} from '@ember/contracts';
import type { EdgeServer as EdgeServerRow, Prisma } from '../generated/prisma/client.js';
import { isDbError, type Db } from '../db.js';
import type { EdgeManager } from '../edgeManager.js';
import { conflict, notFound, orMissing } from '../http.js';
import { deviceId, latLng, limit, nullable, uuid } from '../schemas.js';

const params = {
    type: 'object',
    required: ['edgeServerId'],
    properties: { edgeServerId: deviceId },
} as const;
const one = `${API_EDGE_SERVERS_PATH}/:edgeServerId`;
const zoneId = { type: ['string', 'null'], format: 'uuid' } as const;
const radius = { type: ['number', 'null'], exclusiveMinimum: 0 } as const;

export type LiveRegistry = Map<string, EdgeServerStatus> | null;

type EdgeParams = { edgeServerId: string };
type EdgeQuery = { zoneId?: string; unassigned?: boolean; limit: number };
type EdgeFields = {
    url?: string;
    name?: string | null;
    zoneId?: string | null;
    lat?: number | null;
    lng?: number | null;
    connectivityRadiusM?: number | null;
};

export function edgeServerWire(row: EdgeServerRow, live: LiveRegistry): EdgeServer {
    const status = live?.get(row.id);
    return {
        edgeServerId: row.id,
        url: row.url,
        name: row.name,
        zoneId: row.zoneId as WatchZoneId | null,
        location: row.lat === null || row.lng === null ? null : { lat: row.lat, lng: row.lng },
        connectivityRadiusM: row.connectivityRadiusM,
        live: status
            ? {
                  online: status.online,
                  connectedAt: status.connectedAt,
                  lastSeen: status.lastSeen,
                  drones: status.drones,
                  connectedDrones: status.connectedDrones,
                  run: status.run,
              }
            : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** Only the fields the request names, so a connector's registration keeps what an operator set. */
function changes(body: PutEdgeServerRequest | UpdateEdgeServerRequest): EdgeFields {
    const data: EdgeFields = {};
    if ('url' in body) data.url = body.url;
    if ('name' in body && body.name !== undefined) data.name = body.name;
    if (body.zoneId !== undefined) data.zoneId = body.zoneId;
    if (body.location !== undefined) {
        data.lat = body.location?.lat ?? null;
        data.lng = body.location?.lng ?? null;
    }
    if (body.connectivityRadiusM !== undefined) data.connectivityRadiusM = body.connectivityRadiusM;
    return data;
}

export function edgeServerRoutes(
    app: FastifyInstance,
    { db, edgeManager }: { db: Db; edgeManager: EdgeManager | null },
) {
    const live = async () => (edgeManager ? edgeManager.live() : null);

    app.get<{ Querystring: EdgeQuery }>(
        API_EDGE_SERVERS_PATH,
        {
            schema: {
                querystring: {
                    type: 'object',
                    properties: { zoneId: uuid, unassigned: { type: 'boolean' }, limit },
                },
            },
        },
        async (req, reply) => {
            const where: Prisma.EdgeServerWhereInput = {};
            if (req.query.unassigned) where.zoneId = null;
            else if (req.query.zoneId !== undefined) where.zoneId = req.query.zoneId;
            const [rows, registry] = await Promise.all([
                db.edgeServer.findMany({ where, orderBy: { id: 'asc' }, take: req.query.limit }),
                live(),
            ]);
            return reply.send(rows.map((row) => edgeServerWire(row, registry)));
        },
    );

    app.get<{ Params: EdgeParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await db.edgeServer.findUnique({ where: { id: req.params.edgeServerId } });
        return row
            ? edgeServerWire(row, await live())
            : notFound(reply, `edge server ${req.params.edgeServerId}`);
    });

    app.put<{ Params: EdgeParams; Body: PutEdgeServerRequest }>(
        one,
        {
            schema: {
                params,
                body: {
                    type: 'object',
                    required: ['url'],
                    additionalProperties: false,
                    properties: {
                        url: {
                            type: 'string',
                            format: 'uri',
                            pattern: '^https?://',
                            maxLength: 2000,
                        },
                        zoneId,
                        location: nullable(latLng),
                        connectivityRadiusM: radius,
                    },
                },
            },
        },
        async (req, reply) => {
            const { edgeServerId } = req.params;
            const data = changes(req.body);
            try {
                const row = await db.edgeServer.upsert({
                    where: { id: edgeServerId },
                    create: { ...data, url: req.body.url, id: edgeServerId },
                    update: data,
                });
                return edgeServerWire(row, await live());
            } catch (err) {
                if (isDbError(err, 'P2003')) {
                    return conflict(reply, `watch zone ${req.body.zoneId} does not exist`);
                }
                throw err;
            }
        },
    );

    app.patch<{ Params: EdgeParams; Body: UpdateEdgeServerRequest }>(
        one,
        {
            schema: {
                params,
                body: {
                    type: 'object',
                    minProperties: 1,
                    additionalProperties: false,
                    properties: {
                        name: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
                        zoneId,
                        location: nullable(latLng),
                        connectivityRadiusM: radius,
                    },
                },
            },
        },
        async (req, reply) => {
            const { edgeServerId } = req.params;
            try {
                const row = await orMissing(
                    db.edgeServer.update({ where: { id: edgeServerId }, data: changes(req.body) }),
                );
                return row
                    ? edgeServerWire(row, await live())
                    : notFound(reply, `edge server ${edgeServerId}`);
            } catch (err) {
                if (isDbError(err, 'P2003')) {
                    return conflict(reply, `watch zone ${req.body.zoneId} does not exist`);
                }
                throw err;
            }
        },
    );

    // Its drones stay registered, unassigned.
    app.delete<{ Params: EdgeParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await orMissing(
            db.edgeServer.delete({ where: { id: req.params.edgeServerId } }),
        );
        return row
            ? reply.code(204).send()
            : notFound(reply, `edge server ${req.params.edgeServerId}`);
    });
}
