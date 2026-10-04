import type { FastifyInstance } from 'fastify';
import {
    PLANNER_CONTEXT_PATH,
    PLANNER_JOBS_PATH,
    PLANNER_RESULT_PATH,
    PLANNER_STATUS_PATH,
    WATCH_ZONES_PATH,
} from '@ember/contracts';
import type {
    CreatePlannerJobRequest,
    LatLng,
    PlannerContext,
    PlannerDetection,
    PlannerJob,
    PlannerJobRequest,
    PlannerJobStatusUpdate,
    PlannerOptions,
    PlannerResult,
    PlannerRiskZone,
    WatchZoneId,
} from '@ember/contracts';
import type { PlannerJob as PlannerJobRow } from '../generated/prisma/client.js';
import { operatorOf } from '../auth.js';
import { isDbError, type Db } from '../db.js';
import { centroid } from '../geo.js';
import { conflict, notFound, optionalBody } from '../http.js';
import type { OpenData } from '../openData/types.js';
import type { PlannerQueue } from '../queue.js';
import { dateTime, limit, plannerOptions, uuid } from '../schemas.js';
import { surroundingsWire } from '../surroundings.js';
import { riskDetectionWire } from './detections.js';
import { zoneRiskZones } from './riskZones.js';

/** The newest frames handed to the planner; older evidence is in what they show. */
const CONTEXT_FRAMES = 500;

const zoneParams = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;
const jobParams = { type: 'object', required: ['jobId'], properties: { jobId: uuid } } as const;
const zoneJobs = `${WATCH_ZONES_PATH}/:zoneId/planner-jobs`;

const statusBody = {
    type: 'object',
    required: ['jobId', 'zoneId', 'state', 'at', 'message'],
    properties: {
        jobId: uuid,
        zoneId: uuid,
        state: { enum: ['gathering', 'planning', 'failed'] },
        at: dateTime,
        message: { type: ['string', 'null'], maxLength: 10_000 },
    },
} as const;

// The worker's own model validates the rest; this checks what the api reads.
const resultBody = {
    type: 'object',
    required: [
        'jobId',
        'zoneId',
        'generatedAt',
        'contextGeneratedAt',
        'horizonMin',
        'assumptions',
        'fireSpread',
        'attackZones',
        'civilianImpacts',
        'evacuationRoutes',
    ],
    properties: {
        jobId: uuid,
        zoneId: uuid,
        generatedAt: dateTime,
        contextGeneratedAt: dateTime,
        horizonMin: { type: 'number' },
        assumptions: { type: 'array', items: { type: 'string' } },
        fireSpread: { type: 'object' },
        attackZones: { type: 'array' },
        civilianImpacts: { type: 'array' },
        evacuationRoutes: { type: 'array' },
    },
} as const;

type ZoneParams = { zoneId: string };
type JobParams = { jobId: string };

export function plannerJobWire(row: PlannerJobRow, withResult = false): PlannerJob {
    const job: PlannerJob = {
        jobId: row.id,
        zoneId: row.zoneId as WatchZoneId,
        state: row.state,
        requestedBy: row.requestedBy,
        requestedAt: row.requestedAt.toISOString(),
        options: row.options as PlannerOptions | null,
        message: row.message,
        updatedAt: row.updatedAt.toISOString(),
    };
    if (withResult) job.result = row.result as PlannerResult | null;
    return job;
}

/** Operator-facing: start a plan for a zone and follow it. */
export function plannerJobRoutes(app: FastifyInstance, db: Db, queue: PlannerQueue | null) {
    app.post<{ Params: ZoneParams; Body: CreatePlannerJobRequest }>(
        zoneJobs,
        {
            preValidation: optionalBody,
            schema: {
                params: zoneParams,
                body: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        requestedBy: { type: 'string', minLength: 1, maxLength: 200 },
                        options: plannerOptions,
                    },
                },
            },
        },
        async (req, reply) => {
            if (!queue) return reply.code(503).send({ error: 'planner queue is not configured' });
            const { zoneId } = req.params;
            const requestedBy = req.body.requestedBy ?? operatorOf(req)?.operator.id;
            if (requestedBy === undefined) {
                return reply
                    .code(400)
                    .send({ error: 'requestedBy is required without an operator session' });
            }
            let row: PlannerJobRow;
            try {
                row = await db.plannerJob.create({
                    data: {
                        zoneId,
                        requestedBy,
                        options: req.body.options ?? undefined,
                    },
                });
            } catch (err) {
                if (isDbError(err, 'P2003')) return notFound(reply, `watch zone ${zoneId}`);
                throw err;
            }
            const job: PlannerJobRequest = {
                jobId: row.id,
                zoneId: zoneId as WatchZoneId,
                requestedAt: row.requestedAt.toISOString(),
                requestedBy: row.requestedBy,
            };
            if (req.body.options) job.options = req.body.options;
            try {
                await queue.push(job);
            } catch (err) {
                req.log.error(err, `planner job ${row.id}: queueing failed`);
                await db.plannerJob.update({
                    where: { id: row.id },
                    data: { state: 'failed', message: 'could not reach the planner queue' },
                });
                return reply.code(503).send({ error: `planner job ${row.id}: queue unreachable` });
            }
            return reply.code(202).send(plannerJobWire(row));
        },
    );

    app.get<{ Params: ZoneParams; Querystring: { limit: number } }>(
        zoneJobs,
        {
            schema: {
                params: zoneParams,
                querystring: { type: 'object', properties: { limit } },
            },
        },
        async (req, reply) => {
            const rows = await db.plannerJob.findMany({
                where: { zoneId: req.params.zoneId },
                orderBy: { requestedAt: 'desc' },
                take: req.query.limit,
                omit: { result: true },
            });
            return reply.send(rows.map((row) => plannerJobWire({ ...row, result: null })));
        },
    );

    app.get<{ Params: JobParams }>(
        `${PLANNER_JOBS_PATH}/:jobId`,
        { schema: { params: jobParams } },
        async (req, reply) => {
            const row = await db.plannerJob.findUnique({ where: { id: req.params.jobId } });
            return row
                ? plannerJobWire(row, true)
                : notFound(reply, `planner job ${req.params.jobId}`);
        },
    );
}

/** What the planner orchestrator calls (`planner.ts`). */
export function plannerRoutes(
    app: FastifyInstance,
    { db, openData }: { db: Db; openData: OpenData | null },
) {
    app.get<{ Params: ZoneParams }>(
        PLANNER_CONTEXT_PATH,
        { schema: { params: zoneParams } },
        async (req, reply) => {
            const zone = await db.watchZone.findUnique({ where: { id: req.params.zoneId } });
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            const boundary = zone.boundary as LatLng[];
            const [frames, risk, stored, weather] = await Promise.all([
                db.detectionFrame.findMany({
                    where: { zoneId: zone.id, detections: { some: {} } },
                    orderBy: { capturedAt: 'desc' },
                    take: CONTEXT_FRAMES,
                    include: { detections: { orderBy: { detectionId: 'asc' } } },
                }),
                zoneRiskZones(db, zone),
                db.zoneSurroundings.findUnique({ where: { zoneId: zone.id } }),
                openData
                    ? openData.weather(centroid(boundary)).catch((err: unknown) => {
                          req.log.warn({ err }, `zone ${zone.id}: weather unavailable`);
                          return null;
                      })
                    : null,
            ]);
            const detections: PlannerDetection[] = frames.flatMap((frame) =>
                frame.detections.map((d) => ({
                    ...riskDetectionWire(d),
                    droneId: frame.droneId,
                    capturedAt: frame.capturedAt.toISOString(),
                })),
            );
            const riskZones: PlannerRiskZone[] = risk.riskZones.map((z) => ({
                id: z.id,
                risk: z.risk,
                polygon: z.polygon,
                confidence: z.confidence,
                observedAt: z.observedAt,
            }));
            const around = stored?.status === 'ready' ? surroundingsWire(stored) : null;
            const context: PlannerContext = {
                zoneId: zone.id as WatchZoneId,
                name: zone.name,
                boundary,
                generatedAt: new Date().toISOString(),
                weather,
                terrain: null,
                riskZones,
                detections,
                civilianAreas: around?.civilianAreas ?? [],
                roads: around?.roads ?? [],
                safeZones: around?.safeZones ?? [],
                stations: around?.stations ?? [],
            };
            return context;
        },
    );

    app.post<{ Params: JobParams; Body: PlannerJobStatusUpdate }>(
        PLANNER_STATUS_PATH,
        { schema: { params: jobParams, body: statusBody } },
        async (req, reply) => {
            const update = req.body;
            const job = await db.plannerJob.findUnique({
                where: { id: req.params.jobId },
                select: { zoneId: true, state: true },
            });
            if (!job) return notFound(reply, `planner job ${req.params.jobId}`);
            if (update.jobId !== req.params.jobId || update.zoneId !== job.zoneId) {
                return reply
                    .code(400)
                    .send({ error: `status is for job ${update.jobId} in zone ${update.zoneId}` });
            }
            if (job.state === 'succeeded') {
                return conflict(reply, `planner job ${req.params.jobId} already succeeded`);
            }
            await db.plannerJob.update({
                where: { id: req.params.jobId },
                data: { state: update.state, message: update.message },
            });
            return reply.code(204).send();
        },
    );

    // Delivery retries, so a second copy of an accepted result is accepted again.
    app.post<{ Params: JobParams; Body: PlannerResult }>(
        PLANNER_RESULT_PATH,
        { schema: { params: jobParams, body: resultBody }, bodyLimit: 64 * 1024 * 1024 },
        async (req, reply) => {
            const result = req.body;
            const job = await db.plannerJob.findUnique({
                where: { id: req.params.jobId },
                select: { zoneId: true },
            });
            if (!job) return notFound(reply, `planner job ${req.params.jobId}`);
            if (result.jobId !== req.params.jobId || result.zoneId !== job.zoneId) {
                return reply
                    .code(400)
                    .send({ error: `result is for job ${result.jobId} in zone ${result.zoneId}` });
            }
            await db.plannerJob.update({
                where: { id: req.params.jobId },
                data: { state: 'succeeded', message: null, result },
            });
            return reply.code(204).send();
        },
    );
}
