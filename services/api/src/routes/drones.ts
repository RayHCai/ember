import type { FastifyInstance } from 'fastify';
import { DRONES_PATH } from '@ember/contracts';
import type { Drone, DroneKind, PutDroneRequest } from '@ember/contracts';
import type { Drone as DroneRow, Prisma } from '../generated/prisma/client.js';
import { isDbError, type Db } from '../db.js';
import { conflict, notFound, orMissing } from '../http.js';
import { deviceId, limit, uuid } from '../schemas.js';

const params = {
    type: 'object',
    required: ['droneId'],
    properties: { droneId: deviceId },
} as const;
const one = `${DRONES_PATH}/:droneId`;

type DroneParams = { droneId: string };
type DroneQuery = { edgeServerId?: string; zoneId?: string; limit: number };

export function droneWire(row: DroneRow): Drone {
    return {
        droneId: row.id,
        edgeServerId: row.edgeServerId,
        name: row.name,
        kind: row.kind as DroneKind | null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export function droneRoutes(app: FastifyInstance, db: Db) {
    app.get<{ Querystring: DroneQuery }>(
        DRONES_PATH,
        {
            schema: {
                querystring: {
                    type: 'object',
                    properties: { edgeServerId: deviceId, zoneId: uuid, limit },
                },
            },
        },
        async (req, reply) => {
            const { edgeServerId, zoneId } = req.query;
            const where: Prisma.DroneWhereInput = {};
            if (edgeServerId !== undefined) where.edgeServerId = edgeServerId;
            if (zoneId !== undefined) where.edgeServer = { zoneId };
            const rows = await db.drone.findMany({
                where,
                orderBy: { id: 'asc' },
                take: req.query.limit,
            });
            return reply.send(rows.map(droneWire));
        },
    );

    app.get<{ Params: DroneParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await db.drone.findUnique({ where: { id: req.params.droneId } });
        return row ? droneWire(row) : notFound(reply, `drone ${req.params.droneId}`);
    });

    app.put<{ Params: DroneParams; Body: PutDroneRequest }>(
        one,
        {
            schema: {
                params,
                body: {
                    type: 'object',
                    required: ['edgeServerId'],
                    additionalProperties: false,
                    properties: {
                        edgeServerId: { ...deviceId, type: ['string', 'null'] },
                        name: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
                        kind: { enum: ['simulated', 'physical', null] },
                    },
                },
            },
        },
        async (req, reply) => {
            const { droneId } = req.params;
            const { edgeServerId, name, kind } = req.body;
            const data: Prisma.DroneUncheckedUpdateInput = { edgeServerId };
            if (name !== undefined) data.name = name;
            if (kind !== undefined) data.kind = kind;
            try {
                const row = await db.drone.upsert({
                    where: { id: droneId },
                    create: { id: droneId, edgeServerId, name, kind },
                    update: data,
                });
                return droneWire(row);
            } catch (err) {
                if (isDbError(err, 'P2003')) {
                    return conflict(reply, `edge server ${edgeServerId} is not registered`);
                }
                throw err;
            }
        },
    );

    app.delete<{ Params: DroneParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await orMissing(db.drone.delete({ where: { id: req.params.droneId } }));
        return row ? reply.code(204).send() : notFound(reply, `drone ${req.params.droneId}`);
    });
}
