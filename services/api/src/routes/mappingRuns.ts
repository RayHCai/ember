import type { FastifyInstance } from 'fastify';
import { MAPPING_RUNS_PATH } from '@ember/contracts';
import type { MappingRun, PutMappingRunRequest, WatchZoneId } from '@ember/contracts';
import type { MappingRun as MappingRunRow, Prisma } from '../generated/prisma/client.js';
import { isDbError, type Db } from '../db.js';
import { conflict, notFound, orMissing } from '../http.js';
import { syncScan } from '../scans.js';
import { dateTime, deviceId, latLng, limit, uuid } from '../schemas.js';

const runIdField = { type: 'string', minLength: 1, maxLength: 200 } as const;
const params = {
    type: 'object',
    required: ['runId', 'edgeServerId'],
    properties: { runId: runIdField, edgeServerId: deviceId },
} as const;
const one = `${MAPPING_RUNS_PATH}/:runId/edge-servers/:edgeServerId`;

const edgeRun = {
    type: 'object',
    required: [
        'runId',
        'zoneId',
        'state',
        'startedAt',
        'edgeServer',
        'connectivityRadiusM',
        'cellSizeM',
        'coverage',
        'newCells',
    ],
    properties: {
        runId: runIdField,
        zoneId: uuid,
        state: { enum: ['mapping', 'stopping', 'done'] },
        startedAt: dateTime,
        swarm: { type: 'array', items: { type: 'string' } },
        edgeServer: latLng,
        connectivityRadiusM: { type: 'number', exclusiveMinimum: 0 },
        cellSizeM: { type: 'number', exclusiveMinimum: 0 },
        coverage: { type: 'number', minimum: 0, maximum: 1 },
        newCells: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 2_147_483_647 } },
    },
} as const;

type RunParams = { runId: string; edgeServerId: string };
type RunQuery = { zoneId?: string; runId?: string; edgeServerId?: string; limit: number };

export function mappingRunWire(row: MappingRunRow): MappingRun {
    return {
        runId: row.runId,
        edgeServerId: row.edgeServerId,
        zoneId: row.zoneId as WatchZoneId,
        state: row.state,
        startedAt: row.startedAt.toISOString(),
        edgeServer: { lat: row.lat, lng: row.lng },
        connectivityRadiusM: row.connectivityRadiusM,
        cellSizeM: row.cellSizeM,
        coverage: row.coverage,
        cells: row.cells,
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** Sorted union; both inputs may hold duplicates. */
export function mergeCells(known: number[], fresh: number[]): number[] {
    return [...new Set([...known, ...fresh])].toSorted((a, b) => a - b);
}

export function mappingRunRoutes(app: FastifyInstance, db: Db) {
    app.get<{ Querystring: RunQuery }>(
        MAPPING_RUNS_PATH,
        {
            schema: {
                querystring: {
                    type: 'object',
                    properties: { zoneId: uuid, runId: runIdField, edgeServerId: deviceId, limit },
                },
            },
        },
        async (req, reply) => {
            const { zoneId, runId, edgeServerId } = req.query;
            const where: Prisma.MappingRunWhereInput = {};
            if (zoneId !== undefined) where.zoneId = zoneId;
            if (runId !== undefined) where.runId = runId;
            if (edgeServerId !== undefined) where.edgeServerId = edgeServerId;
            const rows = await db.mappingRun.findMany({
                where,
                orderBy: { startedAt: 'desc' },
                take: req.query.limit,
            });
            return reply.send(rows.map(mappingRunWire));
        },
    );

    app.get<{ Params: RunParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await db.mappingRun.findUnique({ where: { runId_edgeServerId: req.params } });
        return row
            ? mappingRunWire(row)
            : notFound(reply, `run ${req.params.runId} on edge server ${req.params.edgeServerId}`);
    });

    // Takes the connector's `EdgeRun` as edge-manager receives it; newCells add to the stored set,
    // and the scan of the same run id follows.
    app.put<{ Params: RunParams; Body: PutMappingRunRequest }>(
        one,
        { schema: { params, body: edgeRun } },
        async (req, reply) => {
            const key = req.params;
            const run = req.body;
            if (run.runId !== key.runId) {
                return reply
                    .code(400)
                    .send({ error: `body runId ${run.runId} is not ${key.runId}` });
            }
            const known = await db.mappingRun.findUnique({
                where: { runId_edgeServerId: key },
                select: { cells: true },
            });
            const data = {
                zoneId: run.zoneId,
                state: run.state,
                startedAt: new Date(run.startedAt),
                lat: run.edgeServer.lat,
                lng: run.edgeServer.lng,
                connectivityRadiusM: run.connectivityRadiusM,
                cellSizeM: run.cellSizeM,
                coverage: run.coverage,
                cells: mergeCells(known?.cells ?? [], run.newCells),
            };
            try {
                const row = await db.mappingRun.upsert({
                    where: { runId_edgeServerId: key },
                    create: { ...key, ...data },
                    update: data,
                });
                await syncScan(db, key.runId);
                return mappingRunWire(row);
            } catch (err) {
                if (isDbError(err, 'P2003')) {
                    return conflict(reply, `watch zone ${run.zoneId} does not exist`);
                }
                throw err;
            }
        },
    );

    app.delete<{ Params: RunParams }>(one, { schema: { params } }, async (req, reply) => {
        const row = await orMissing(
            db.mappingRun.delete({ where: { runId_edgeServerId: req.params } }),
        );
        return row
            ? reply.code(204).send()
            : notFound(reply, `run ${req.params.runId} on edge server ${req.params.edgeServerId}`);
    });
}
