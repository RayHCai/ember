import type { FastifyInstance } from 'fastify';
import { ZONE_RISK_ZONES_PATH } from '@ember/contracts';
import type { LatLng, RiskZonesView, WatchZoneId } from '@ember/contracts';
import type { Db } from '../db.js';
import { notFound } from '../http.js';
import { mergeRiskZones } from '../riskZones.js';
import { uuid } from '../schemas.js';

const WEEK_MS = 7 * 24 * 3_600_000;
/** Frames read per merge; the newest win. */
const RISK_FRAMES = 5_000;

const params = { type: 'object', required: ['zoneId'], properties: { zoneId: uuid } } as const;

/** The latest scan's start (a failed scan never flew, so it does not count), else a week ago. */
async function riskSince(db: Db, zoneId: string, now: Date): Promise<Date> {
    const scan = await db.scan.findFirst({
        where: { zoneId, state: { not: 'failed' } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
    });
    return scan?.startedAt ?? new Date(now.getTime() - WEEK_MS);
}

/** The zone's detections since its latest scan, merged into risk zones. */
export async function zoneRiskZones(
    db: Db,
    zone: { id: string; boundary: unknown },
    now = new Date(),
): Promise<RiskZonesView> {
    const since = await riskSince(db, zone.id, now);
    const frames = await db.detectionFrame.findMany({
        where: { zoneId: zone.id, capturedAt: { gte: since }, detections: { some: {} } },
        orderBy: { capturedAt: 'desc' },
        take: RISK_FRAMES,
        select: {
            id: true,
            droneId: true,
            capturedAt: true,
            detections: {
                select: {
                    detectionId: true,
                    risk: true,
                    confidence: true,
                    ground: true,
                    centerLat: true,
                    centerLng: true,
                },
            },
        },
    });
    const riskZones = mergeRiskZones(
        zone.boundary as LatLng[],
        frames.map((f) => ({
            id: f.id,
            droneId: f.droneId,
            capturedAt: f.capturedAt,
            detections: f.detections.map((d) => ({
                detectionId: d.detectionId,
                risk: d.risk,
                confidence: d.confidence,
                ground: d.ground as LatLng[],
                center: { lat: d.centerLat, lng: d.centerLng },
            })),
        })),
    );
    return {
        zoneId: zone.id as WatchZoneId,
        since: since.toISOString(),
        generatedAt: now.toISOString(),
        riskZones,
    };
}

export function riskZoneRoutes(app: FastifyInstance, db: Db) {
    app.get<{ Params: { zoneId: string } }>(
        ZONE_RISK_ZONES_PATH,
        { schema: { params } },
        async (req, reply) => {
            const zone = await db.watchZone.findUnique({
                where: { id: req.params.zoneId },
                select: { id: true, boundary: true },
            });
            if (!zone) return notFound(reply, `watch zone ${req.params.zoneId}`);
            return zoneRiskZones(db, zone);
        },
    );
}
