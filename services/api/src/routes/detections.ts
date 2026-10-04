import type { FastifyInstance } from 'fastify';
import {
    DETECTION_PATH,
    DETECTIONS_INGEST_PATH,
    ZONE_DETECTIONS_PATH,
    ZONE_SIMULATED_DETECTIONS_PATH,
    type DetectionRecord,
    type DetectionVerification,
    type DetectionsIngestResult,
    type RiskZoneRecord,
    type WatchZoneId,
} from '@ember/contracts';
import { guard, STAFF } from '../auth.js';
import { iso, requireZone, type Deps } from '../deps.js';
import { notFound, parse } from '../errors.js';
import { circle, contains } from '../geo.js';
import * as s from '../schemas.js';
import { z } from 'zod';

const listQuery = z.object({
    since: z.iso.datetime({ offset: true }).optional(),
    verification: z.enum(['unverified', 'verifying', 'confirmed', 'dismissed']).optional(),
});

export function detectionRoutes(app: FastifyInstance, deps: Deps) {
    const { store } = deps;
    const staff = { preHandler: guard(deps.keys, STAFF) };

    app.post(
        DETECTIONS_INGEST_PATH,
        { preHandler: guard(deps.keys, ['ingest', ...STAFF]) },
        async (req) => {
            const frame = parse(s.detectionsFrame, req.body);
            const zones = await store.zones.list();
            const receivedAt = iso(deps.now());
            const result: DetectionsIngestResult = { accepted: 0, dropped: 0 };
            for (const d of frame.detections) {
                const zone = zones.find((w) => contains(w.boundary, d.center));
                if (!zone) {
                    result.dropped += 1;
                    continue;
                }
                // A drone keeps a region's id across frames, so a repeat refines one record.
                const id = `${frame.droneId}:${d.id}`;
                const previous = await store.detections.get(id);
                await store.detections.put({
                    ...d,
                    id,
                    droneId: frame.droneId,
                    capturedAt: frame.capturedAt,
                    zoneId: zone.id,
                    source: 'drone',
                    receivedAt: previous?.receivedAt ?? receivedAt,
                    verification: previous?.verification ?? 'unverified',
                });
                result.accepted += 1;
            }
            return result;
        },
    );

    app.post<{ Params: { zoneId: string } }>(
        ZONE_SIMULATED_DETECTIONS_PATH,
        staff,
        async (req, reply) => {
            const zone = await requireZone(store, req.params.zoneId);
            const body = parse(s.simulatedDetection, req.body);
            const now = iso(deps.now());
            const record: DetectionRecord = {
                id: `simulation:${crypto.randomUUID()}`,
                risk: body.risk,
                confidence: body.confidence,
                bboxPx: [0, 0, 0, 0],
                ground: circle(body.center, body.radiusM, 12),
                center: body.center,
                areaM2: Math.round(Math.PI * body.radiusM ** 2),
                droneId: 'simulation',
                capturedAt: now,
                zoneId: zone.id,
                source: 'simulated',
                receivedAt: now,
                verification: 'unverified',
            };
            await store.detections.insert(record);
            return reply.code(201).send(record);
        },
    );

    app.get<{ Params: { zoneId: string }; Querystring: unknown }>(
        ZONE_DETECTIONS_PATH,
        staff,
        async (req) => {
            await requireZone(store, req.params.zoneId);
            const q = parse(listQuery, req.query, 'query');
            const all = await store.detections.list(
                {
                    zoneId: req.params.zoneId as WatchZoneId,
                    ...(q.verification ? { verification: q.verification } : {}),
                },
                { orderBy: 'receivedAt', desc: true },
            );
            return q.since ? all.filter((d) => d.receivedAt > iso(new Date(q.since!))) : all;
        },
    );

    app.get<{ Params: { detectionId: string } }>(DETECTION_PATH, staff, async (req) => {
        const d = await store.detections.get(req.params.detectionId);
        if (!d) throw notFound(`detection ${req.params.detectionId}`);
        return d;
    });

    app.patch<{ Params: { detectionId: string } }>(DETECTION_PATH, staff, async (req) => {
        const d = await store.detections.get(req.params.detectionId);
        if (!d) throw notFound(`detection ${req.params.detectionId}`);
        const body = parse(s.detectionVerification, req.body);
        d.verification = body.verification as DetectionVerification;
        await store.detections.put(d);
        if (body.verification === 'confirmed' && d.ground.length >= 3) {
            const existing = await store.riskZones.list({ zoneId: d.zoneId });
            if (!existing.some((r) => r.detectionIds.includes(d.id))) {
                const zone: RiskZoneRecord = {
                    id: crypto.randomUUID(),
                    zoneId: d.zoneId,
                    risk: d.risk,
                    polygon: d.ground,
                    confidence: d.confidence,
                    observedAt: d.capturedAt,
                    source: 'detection',
                    detectionIds: [d.id],
                };
                await store.riskZones.insert(zone);
            }
        }
        return d;
    });
}
