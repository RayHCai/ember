import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZONE_SCANS_PATH } from '@ember/contracts';
import type { StartScanRequest } from '@ember/contracts';
import { operatorOf } from '../auth.js';
import {
    DEFAULT_CELL_SIZE_M,
    ScanError,
    scansWire,
    startScan,
    stopScan,
    type ScanDeps,
} from '../scans.js';
import { notFound, optionalBody } from '../http.js';
import { limit, uuid } from '../schemas.js';

const zoneParams = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;
const runParams = {
    type: 'object',
    required: ['zoneId', 'runId'],
    properties: { zoneId: uuid, runId: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

type ZoneParams = { zoneId: string };

const scanError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ScanError) return reply.code(err.status).send({ error: err.message });
    throw err;
};

export function scanRoutes(app: FastifyInstance, deps: ScanDeps) {
    const { db } = deps;

    app.post<{ Params: ZoneParams; Body: StartScanRequest }>(
        ZONE_SCANS_PATH,
        {
            preValidation: optionalBody,
            schema: {
                params: zoneParams,
                body: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { cellSizeM: { type: 'number', minimum: 1, maximum: 1000 } },
                },
            },
        },
        async (req, reply) => {
            const zone = await db.watchZone.findUnique({
                where: { id: req.params.zoneId },
                select: { id: true, boundary: true },
            });
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            try {
                const row = await startScan(deps, zone, {
                    cellSizeM: req.body.cellSizeM ?? DEFAULT_CELL_SIZE_M,
                    requestedBy: operatorOf(req)?.operator.id ?? 'service',
                });
                const [scan] = await scansWire(db, [row]);
                return reply.code(201).send(scan);
            } catch (err) {
                return scanError(reply, err);
            }
        },
    );

    app.get<{ Params: ZoneParams; Querystring: { limit: number } }>(
        ZONE_SCANS_PATH,
        { schema: { params: zoneParams, querystring: { type: 'object', properties: { limit } } } },
        async (req, reply) => {
            const rows = await db.scan.findMany({
                where: { zoneId: req.params.zoneId },
                orderBy: { startedAt: 'desc' },
                take: req.query.limit,
            });
            return reply.send(await scansWire(db, rows));
        },
    );

    app.post<{ Params: ZoneParams & { runId: string } }>(
        `${ZONE_SCANS_PATH}/:runId/stop`,
        { schema: { params: runParams } },
        async (req, reply) => {
            try {
                const row = await stopScan(deps, req.params.zoneId, req.params.runId);
                const [scan] = await scansWire(db, [row]);
                return scan;
            } catch (err) {
                return scanError(reply, err);
            }
        },
    );
}
