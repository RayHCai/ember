import type { FastifyInstance } from 'fastify';
import { ZONE_SUMMARIES_PATH } from '@ember/contracts';
import type { LatLng, Scan, WatchZoneSummary, ZoneSummary } from '@ember/contracts';
import type { Db } from '../db.js';
import type { EdgeManager } from '../edgeManager.js';
import { coverage, type Circle } from '../geo.js';
import { scansWire } from '../scans.js';
import { limit } from '../schemas.js';
import { zoneRiskZones } from './riskZones.js';
import { watchZoneWire } from './watchZones.js';

const countBy = <T>(items: T[], keyOf: (item: T) => string | null | undefined) => {
    const counts = new Map<string, number>();
    for (const item of items) {
        const k = keyOf(item);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
};

/** `GET ${ZONE_SUMMARIES_PATH}`: what the zone list shows, newest zone first. */
export function zoneSummaryRoutes(
    app: FastifyInstance,
    { db, edgeManager }: { db: Db; edgeManager: EdgeManager | null },
) {
    app.get<{ Querystring: { limit: number } }>(
        ZONE_SUMMARIES_PATH,
        { schema: { querystring: { type: 'object', properties: { limit } } } },
        async (req, reply) => {
            const zones = await db.watchZone.findMany({
                orderBy: { createdAt: 'desc' },
                take: req.query.limit,
            });
            if (zones.length === 0) return reply.send([]);
            const ids = zones.map((z) => z.id);
            const [edges, placements, drones, scans, plans, live] = await Promise.all([
                db.edgeServer.findMany({
                    where: { zoneId: { in: ids }, lat: { not: null }, lng: { not: null } },
                    select: {
                        id: true,
                        zoneId: true,
                        lat: true,
                        lng: true,
                        connectivityRadiusM: true,
                    },
                }),
                db.edgeServerPlacement.findMany({
                    where: { zoneId: { in: ids } },
                    select: { zoneId: true },
                }),
                db.drone.findMany({
                    where: { edgeServer: { zoneId: { in: ids } } },
                    select: { edgeServer: { select: { zoneId: true } } },
                }),
                db.scan.findMany({
                    where: { zoneId: { in: ids } },
                    orderBy: { startedAt: 'desc' },
                    distinct: ['zoneId'],
                }),
                db.plannerJob.findMany({
                    where: { zoneId: { in: ids }, state: 'succeeded' },
                    orderBy: { updatedAt: 'desc' },
                    distinct: ['zoneId'],
                    select: { zoneId: true, updatedAt: true },
                }),
                edgeManager?.live() ?? null,
            ]);
            const lastScans = new Map<string, Scan>(
                (await scansWire(db, scans)).map((s) => [s.zoneId, s]),
            );
            const placementCounts = countBy(placements, (p) => p.zoneId);
            const droneCounts = countBy(drones, (d) => d.edgeServer?.zoneId);
            const lastPlans = new Map(plans.map((p) => [p.zoneId, p.updatedAt.toISOString()]));
            const risks = await Promise.all(zones.map((zone) => zoneRiskZones(db, zone)));

            const summaries = zones.map((zone, i): WatchZoneSummary => {
                const deployed = edges.filter((e) => e.zoneId === zone.id);
                const circles = deployed.flatMap((e): Circle[] =>
                    e.lat === null || e.lng === null || e.connectivityRadiusM === null
                        ? []
                        : [{ center: { lat: e.lat, lng: e.lng }, radiusM: e.connectivityRadiusM }],
                );
                const riskZones = risks[i]!.riskZones;
                const onFire = riskZones.filter((z) => z.risk === 'on_fire');
                const atRisk = riskZones.filter((z) => z.risk === 'at_risk');
                const area = (list: typeof riskZones) => list.reduce((s, z) => s + z.areaM2, 0);
                const summary: ZoneSummary = {
                    edgeServers: deployed.length,
                    onlineEdgeServers: deployed.filter((e) => live?.get(e.id)?.online).length,
                    placements: placementCounts.get(zone.id) ?? 0,
                    drones: droneCounts.get(zone.id) ?? 0,
                    coverage: coverage(zone.boundary as LatLng[], circles),
                    lastScan: lastScans.get(zone.id) ?? null,
                    riskZones: {
                        onFire: onFire.length,
                        atRisk: atRisk.length,
                        onFireM2: area(onFire),
                        atRiskM2: area(atRisk),
                    },
                    lastPlanAt: lastPlans.get(zone.id) ?? null,
                };
                return Object.assign(watchZoneWire(zone), { summary });
            });
            return reply.send(summaries);
        },
    );
}
