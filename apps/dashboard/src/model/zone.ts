import type { LatLng, RiskZone, Scan, WatchZoneSummary } from '@ember/contracts';
import { computeCoverage, makeGrid, polygonAreaKm2 } from './geo';
import type { Grid, LatLon, ServerView, ZoneRecords, ZoneStatus, ZoneView } from './types';

export const ll = (p: LatLng): LatLon => [p.lat, p.lng];
export const latLng = ([lat, lng]: LatLon): LatLng => ({ lat, lng });

const ACTIVE_SCAN = new Set<Scan['state']>(['starting', 'mapping', 'stopping']);
const ACTIVE_PLAN = new Set(['queued', 'gathering', 'planning']);

export const isActiveScan = (scan: Scan | null | undefined): boolean =>
    Boolean(scan && ACTIVE_SCAN.has(scan.state));

/** Cells fine enough for 10 m mapping cells on small zones, capped for large ones. */
function gridFor(boundary: LatLon[]): Grid {
    const lats = boundary.map((p) => p[0]);
    const lons = boundary.map((p) => p[1]);
    const h = (Math.max(...lats) - Math.min(...lats)) * 111_320;
    const w =
        (Math.max(...lons) - Math.min(...lons)) *
        111_320 *
        Math.cos(((Math.max(...lats) + Math.min(...lats)) / 2) * (Math.PI / 180));
    return makeGrid(boundary, Math.max(10, Math.ceil(Math.sqrt((w * h) / 60_000))));
}

const grids = new WeakMap<LatLng[], { boundary: LatLon[]; grid: Grid; areaKm2: number }>();

function shape(boundary: LatLng[]) {
    let s = grids.get(boundary);
    if (!s) {
        const points = boundary.map(ll);
        s = {
            boundary: points,
            grid: gridFor(points),
            areaKm2: Math.round(polygonAreaKm2(points) * 10) / 10,
        };
        grids.set(boundary, s);
    }
    return s;
}

function servers(r: ZoneRecords): ServerView[] {
    const deployed: ServerView[] = r.edgeServers
        .filter((e) => e.location && e.connectivityRadiusM)
        .map((e) => ({
            id: e.edgeServerId,
            name: e.name ?? e.edgeServerId.slice(0, 10),
            lat: e.location!.lat,
            lon: e.location!.lng,
            radiusM: e.connectivityRadiusM!,
            status: 'deployed' as const,
            online: e.live ? e.live.online : null,
            edge: e,
            placement: null,
        }));
    const pending: ServerView[] = r.placements.map((p) => ({
        id: p.placementId,
        name: p.name,
        lat: p.location.lat,
        lon: p.location.lng,
        radiusM: p.connectivityRadiusM,
        status: 'pending' as const,
        online: null,
        edge: null,
        placement: p,
    }));
    return [...deployed, ...pending];
}

const views = new WeakMap<ZoneRecords, ZoneView>();

/** The view of a zone; the same records always give the same object. */
export function zoneView(r: ZoneRecords): ZoneView {
    const cached = views.get(r);
    if (cached) return cached;
    const { boundary, grid, areaKm2: area } = shape(r.zone.boundary);
    const scan = r.scans.find((s) => ACTIVE_SCAN.has(s.state)) ?? null;
    const lastDone = r.scans.find((s) => s.state === 'done');
    const latestJob = r.planJobs[0] ?? null;
    const view: ZoneView = {
        id: r.zone.id,
        name: r.zone.name,
        region: r.zone.region ?? '',
        createdAt: Date.parse(r.zone.createdAt),
        boundary,
        areaKm2: area,
        grid,
        servers: servers(r),
        drones: r.drones.map((d) => ({
            id: d.droneId,
            name: d.name ?? d.droneId,
            serverId: d.edgeServerId,
            kind: d.kind,
            registeredAt: Date.parse(d.createdAt),
        })),
        schedule: {
            enabled: r.zone.scanEveryHours !== null,
            everyHours: r.zone.scanEveryHours ?? 12,
            nextAt: r.zone.nextScanAt ? Date.parse(r.zone.nextScanAt) : null,
        },
        scan,
        lastScan: r.scans[0] ?? null,
        lastScanAt: lastDone ? Date.parse(lastDone.endedAt ?? lastDone.updatedAt) : null,
        runs: r.runs,
        riskZones: r.riskZones?.riskZones ?? [],
        surroundings: r.surroundings,
        planJob: latestJob,
        plan: r.plan?.result ?? null,
        planAt: r.plan?.result ? Date.parse(r.plan.result.generatedAt) : null,
        planning: latestJob !== null && ACTIVE_PLAN.has(latestJob.state),
        blasts: r.blasts,
        weather: r.weather,
    };
    views.set(r, view);
    return view;
}

export const deployed = (zone: Pick<ZoneView, 'servers'>) =>
    zone.servers.filter((s) => s.status === 'deployed');

/** Percent (one decimal) of the zone within a deployed server's radius. */
export function coveragePct(zone: Pick<ZoneView, 'grid' | 'servers'>): number {
    const d = deployed(zone);
    return d.length ? computeCoverage(zone.grid, d).pct : 0;
}

export function setupStep(zone: Pick<ZoneView, 'servers' | 'drones'>): 2 | 3 | null {
    if (deployed(zone).length === 0) return 2;
    if (zone.drones.length === 0) return 3;
    return null;
}

export interface RiskTotals {
    onFire: number;
    atRisk: number;
    onFireHa: number;
    atRiskHa: number;
}

export function riskTotals(zones: RiskZone[]): RiskTotals {
    const t = { onFire: 0, atRisk: 0, onFireHa: 0, atRiskHa: 0 };
    for (const z of zones) {
        if (z.risk === 'on_fire') {
            t.onFire += 1;
            t.onFireHa += z.areaM2 / 10_000;
        } else {
            t.atRisk += 1;
            t.atRiskHa += z.areaM2 / 10_000;
        }
    }
    return t;
}

export function zoneStatus(zone: ZoneView): ZoneStatus {
    if (setupStep(zone)) return 'setup';
    const t = riskTotals(zone.riskZones);
    if (t.onFire) return 'on_fire';
    if (t.atRisk) return 'at_risk';
    return zone.lastScanAt === null && !zone.scan ? 'awaiting' : 'healthy';
}

export function summaryStep(z: WatchZoneSummary): 2 | 3 | null {
    if (z.summary.edgeServers === 0) return 2;
    if (z.summary.drones === 0) return 3;
    return null;
}

export function summaryStatus(z: WatchZoneSummary): ZoneStatus {
    if (summaryStep(z)) return 'setup';
    if (z.summary.riskZones.onFire) return 'on_fire';
    if (z.summary.riskZones.atRisk) return 'at_risk';
    const scan = z.summary.lastScan;
    return scan === null || (scan.state !== 'done' && !isActiveScan(scan)) ? 'awaiting' : 'healthy';
}

/** `ha` with sensible precision. */
export function hectares(ha: number): string {
    if (ha === 0) return '0';
    return ha < 1 ? ha.toFixed(2) : ha < 10 ? ha.toFixed(1) : Math.round(ha).toString();
}
