import type { FastifyInstance } from 'fastify';
import {
    PLANNER_CONTEXT_PATH,
    PLANNER_JOB_PATH,
    PLANNER_RESULT_PATH,
    PLANNER_STATUS_PATH,
    ZONE_LATEST_PLAN_PATH,
    ZONE_PLANNER_JOBS_PATH,
    type PlannerContext,
    type PlannerJob,
    type PlannerJobView,
    type PlannerResult,
    type WatchZone,
    type WatchZoneId,
} from '@ember/contracts';
import { guard, STAFF } from '../auth.js';
import { geographyOf, iso, requireZone, type Deps } from '../deps.js';
import { HttpError, notFound, parse } from '../errors.js';
import * as s from '../schemas.js';

export async function plannerContext(deps: Deps, zone: WatchZone): Promise<PlannerContext> {
    const { store } = deps;
    const geo = await geographyOf(store, zone);
    const [riskZones, detections, weather] = await Promise.all([
        store.riskZones.list({ zoneId: zone.id }),
        store.detections.list({ zoneId: zone.id }),
        deps.weather.current(zone.center).catch(() => null),
    ]);
    const confirmed = new Set(riskZones.flatMap((r) => r.detectionIds));
    return {
        zoneId: zone.id,
        name: zone.name,
        boundary: zone.boundary,
        generatedAt: iso(deps.now()),
        weather,
        terrain: geo.terrain,
        riskZones: riskZones.map(({ zoneId: _, source: __, detectionIds: ___, ...r }) => r),
        // A confirmed detection is in the context as its risk zone already.
        detections: detections
            .filter((d) => d.verification !== 'dismissed' && !confirmed.has(d.id))
            .map(({ zoneId: _, source: __, receivedAt: ___, verification: ____, ...d }) => d),
        civilianAreas: geo.civilianAreas,
        roads: geo.roads,
        safeZones: geo.safeZones,
        stations: geo.stations,
    };
}

export function plannerRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };
    const planner = { preHandler: guard(deps.keys, ['planner']) };

    async function requireJob(jobId: string): Promise<PlannerJob> {
        const job = await store.plannerJobs.get(jobId);
        if (!job) throw notFound(`planner job ${jobId}`);
        return job;
    }

    async function view(job: PlannerJob): Promise<PlannerJobView> {
        return { job, result: await store.plannerResults.get(job.jobId) };
    }

    app.get<{ Params: { zoneId: string } }>(
        PLANNER_CONTEXT_PATH,
        { preHandler: guard(deps.keys, ['planner', ...STAFF]) },
        async (req) => plannerContext(deps, await requireZone(store, req.params.zoneId)),
    );

    app.post<{ Params: { zoneId: string } }>(ZONE_PLANNER_JOBS_PATH, staff, async (req, reply) => {
        const zone = await requireZone(store, req.params.zoneId);
        const body = parse(s.enqueuePlannerJob, req.body);
        if (body.incidentId && !(await store.incidents.get(body.incidentId))) {
            throw notFound(`incident ${body.incidentId}`);
        }
        const now = iso(deps.now());
        const job: PlannerJob = {
            jobId: crypto.randomUUID(),
            zoneId: zone.id,
            state: 'queued',
            requestedBy: body.requestedBy,
            requestedAt: now,
            updatedAt: now,
            message: null,
            options: body.options ?? {},
            reason: body.reason ?? null,
            incidentId: body.incidentId ?? null,
        };
        await store.plannerJobs.insert(job);
        try {
            await deps.queue.enqueue({
                jobId: job.jobId,
                zoneId: zone.id,
                requestedAt: now,
                requestedBy: job.requestedBy,
                options: job.options,
            });
        } catch (err) {
            job.state = 'failed';
            job.message = `queue unavailable: ${err instanceof Error ? err.message : String(err)}`;
            await store.plannerJobs.put(job);
            throw new HttpError(503, job.message, { job });
        }
        return reply.code(202).send(job);
    });

    app.get<{ Params: { zoneId: string } }>(ZONE_PLANNER_JOBS_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        return store.plannerJobs.list(
            { zoneId: req.params.zoneId as WatchZoneId },
            { orderBy: 'requestedAt', desc: true, limit: 50 },
        );
    });

    app.get<{ Params: { zoneId: string } }>(ZONE_LATEST_PLAN_PATH, staff, async (req) => {
        await requireZone(store, req.params.zoneId);
        const [job] = await store.plannerJobs.list(
            { zoneId: req.params.zoneId as WatchZoneId, state: 'succeeded' },
            { orderBy: 'updatedAt', desc: true, limit: 1 },
        );
        if (!job) throw notFound(`a succeeded plan for zone ${req.params.zoneId}`);
        return view(job);
    });

    app.get<{ Params: { jobId: string } }>(PLANNER_JOB_PATH, staff, async (req) =>
        view(await requireJob(req.params.jobId)),
    );

    app.post<{ Params: { jobId: string } }>(PLANNER_STATUS_PATH, planner, async (req) => {
        const job = await requireJob(req.params.jobId);
        const body = parse(s.plannerStatus, req.body);
        if (body.jobId !== job.jobId) throw new HttpError(400, 'jobId does not match the path');
        if (job.state === 'succeeded') return job;
        job.state = body.state;
        job.message = body.message;
        job.updatedAt = iso(deps.now());
        await store.plannerJobs.put(job);
        return job;
    });

    app.post<{ Params: { jobId: string } }>(PLANNER_RESULT_PATH, planner, async (req) => {
        const job = await requireJob(req.params.jobId);
        parse(s.plannerResult, req.body);
        const result = req.body as PlannerResult;
        if (result.jobId !== job.jobId || result.zoneId !== job.zoneId) {
            throw new HttpError(400, `result is for job ${result.jobId} in zone ${result.zoneId}`);
        }
        await store.plannerResults.put(result);
        job.state = 'succeeded';
        job.message = null;
        job.updatedAt = iso(deps.now());
        await store.plannerJobs.put(job);
        if (job.incidentId) {
            const incident = await store.incidents.get(job.incidentId);
            if (incident && incident.latestJobId !== job.jobId) {
                incident.previousJobId = incident.latestJobId;
                incident.latestJobId = job.jobId;
                incident.updatedAt = job.updatedAt;
                await store.incidents.put(incident);
                await store.incidentEvents.insert({
                    id: crypto.randomUUID(),
                    incidentId: incident.id,
                    kind: 'plan',
                    summary: `Plan ready: ${result.attackZones.length} attack zones, ${result.civilianImpacts.filter((i) => i.severity !== 'clear').length} civilian areas affected`,
                    refs: { jobId: job.jobId },
                    actor: 'planner',
                    at: job.updatedAt,
                });
            }
        }
        return { accepted: true };
    });
}
