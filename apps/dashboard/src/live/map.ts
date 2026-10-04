import type {
    Approval,
    CivilianAlertDraft,
    CivilianArea,
    DetectionRecord,
    EdgeServerRecord,
    FireSpreadForecast,
    Incident,
    IncidentState,
    LatLng,
    PlannerJob,
    PlannerResult,
    Responder as ApiResponder,
    ResponderAssignment,
    RiskZoneRecord,
    SafeZone as ApiSafeZone,
    WatchZone as ApiWatchZone,
    ZoneGeography,
} from '@ember/contracts';
import {
    cellAt,
    cellCenter,
    centroid,
    computeCoverage,
    metersPerDegLon,
    pointInPolygon,
} from '../sim/geo';
import type {
    CivilianImpact,
    CivilianPlan,
    Community,
    DropSite,
    EdgeServer,
    EdgeServerHealth,
    EvacuationRoute,
    Grid,
    LatLon,
    Responder,
    ResponderPlan,
    SafeZone,
    SpreadForecast,
    WatchZone,
    ZoneRoad,
} from '../sim/types';
import { buildZone } from '../sim/world';
import { minutes } from '../ui/format';

// Api shapes into the dashboard's own types, so the existing layers and panels draw live data.

const M_PER_DEG_LAT = 111_320;
const LIVE_PREFIX = 'live-';
const OPEN_STATES: ReadonlySet<IncidentState> = new Set(['suspected', 'verifying', 'active']);

/** The api does not report hardware health; the inspector shows live status instead. */
const NO_HEALTH: EdgeServerHealth = {
    cpuPct: 0,
    memoryPct: 0,
    temperatureC: 0,
    latencyMs: 0,
    uptimeH: 0,
    firmware: 'unknown',
    power: 'grid',
};

export function liveZoneId(apiZoneId: string): string {
    return `${LIVE_PREFIX}${apiZoneId}`;
}

export function isLiveZoneId(zoneId: string): boolean {
    return zoneId.startsWith(LIVE_PREFIX);
}

export function toLatLon(p: LatLng): LatLon {
    return [p.lat, p.lng];
}

export function liveZone(api: ApiWatchZone, now: number): WatchZone {
    const zone = buildZone({
        id: liveZoneId(api.id),
        name: `${api.name} · Live`,
        region: 'Live from the Ember api',
        boundary: api.boundary.map(toLatLon),
        createdAt: Date.parse(api.createdAt),
        hazards: [],
        communities: [],
        safeZones: [],
    });
    return { ...zone, live: true, lastScanAt: now, roads: [] };
}

export function edgeServers(records: EdgeServerRecord[]): EdgeServer[] {
    return records.map((r) => ({
        id: r.edgeServerId,
        name: r.name,
        lat: r.location.lat,
        lon: r.location.lng,
        radiusM: r.connectivityRadiusM,
        status: 'deployed',
        health: NO_HEALTH,
        live: r.live
            ? {
                  online: r.live.online,
                  drones: r.live.drones,
                  connectedDrones: r.live.connectedDrones,
                  lastSeenAt: Date.parse(r.live.lastSeen),
              }
            : null,
    }));
}

export function communities(areas: CivilianArea[]): Community[] {
    return areas.map((a) => ({
        id: a.id,
        name: a.name,
        lat: a.center.lat,
        lon: a.center.lng,
        population: a.population,
    }));
}

export function safeZones(zones: ApiSafeZone[]): SafeZone[] {
    return zones.map((s) => ({ id: s.id, name: s.name, lat: s.location.lat, lon: s.location.lng }));
}

export function roads(list: ZoneGeography['roads']): ZoneRoad[] {
    return list.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path.map(toLatLon),
        state: r.state ?? 'open',
    }));
}

export function responders(list: ApiResponder[]): Responder[] {
    return list.map((r) => ({
        id: r.id,
        name: r.name,
        unit: r.role.replace(/_/g, ' '),
        device: r.availability,
        joinedAt: Date.parse(r.updatedAt),
    }));
}

/** The newest incident still being worked: suspected, verifying or active. */
export function openIncident(incidents: Incident[]): Incident | null {
    return (
        incidents.filter((i) => OPEN_STATES.has(i.state)).sort((a, b) => b.number - a.number)[0] ??
        null
    );
}

/**
 * The plan to draw: the open incident's latest, else the newest routine plan. A closed
 * incident's plan would draw a fire that is already out.
 */
export function planJobId(incident: Incident | null, jobs: PlannerJob[]): string | null {
    if (incident?.latestJobId) return incident.latestJobId;
    const routine = jobs
        .filter((j) => j.state === 'succeeded' && j.incidentId === null)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return routine[0]?.jobId ?? null;
}

export interface LiveHazard {
    risk: 'at_risk' | 'on_fire';
    polygon: LatLon[];
    center: LatLon;
}

/** Detections and risk zones still in play: not dismissed and not part of a closed incident. */
export function activeHazards(
    detections: DetectionRecord[],
    riskZones: RiskZoneRecord[],
    incidents: Incident[],
): LiveHazard[] {
    const closed = new Set(
        incidents.filter((i) => i.state === 'closed').flatMap((i) => i.detectionIds),
    );
    const out: LiveHazard[] = [];
    for (const d of detections) {
        if (d.verification === 'dismissed' || closed.has(d.id)) continue;
        out.push({ risk: d.risk, polygon: d.ground.map(toLatLon), center: toLatLon(d.center) });
    }
    for (const z of riskZones) {
        if (z.detectionIds.length > 0 && z.detectionIds.every((id) => closed.has(id))) continue;
        const polygon = z.polygon.map(toLatLon);
        out.push({ risk: z.risk, polygon, center: centroid(polygon) });
    }
    return out;
}

/**
 * Per cell, see CellRisk. Ground inside an edge server's radius counts as watched (no risk);
 * hazard outlines paint over it, fire over risk.
 */
export function riskMap(grid: Grid, hazards: LiveHazard[], servers: EdgeServer[]): Uint8Array {
    const risk = computeCoverage(grid, servers).covered;
    const clampRow = (r: number) => Math.max(0, Math.min(grid.rows - 1, r));
    const clampCol = (c: number) => Math.max(0, Math.min(grid.cols - 1, c));
    for (const h of hazards) {
        const level = h.risk === 'on_fire' ? 3 : 2;
        const mark = (i: number) => {
            if (risk[i]! < level) risk[i] = level;
        };
        if (h.polygon.length >= 3) {
            const lats = h.polygon.map((p) => p[0]);
            const lons = h.polygon.map((p) => p[1]);
            const r0 = clampRow(Math.floor((Math.min(...lats) - grid.south) / grid.dlat));
            const r1 = clampRow(Math.floor((Math.max(...lats) - grid.south) / grid.dlat));
            const c0 = clampCol(Math.floor((Math.min(...lons) - grid.west) / grid.dlon));
            const c1 = clampCol(Math.floor((Math.max(...lons) - grid.west) / grid.dlon));
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const i = r * grid.cols + c;
                    if (pointInPolygon(cellCenter(grid, i), h.polygon)) mark(i);
                }
            }
        }
        const at = cellAt(grid, h.center);
        if (at !== null) mark(at);
    }
    return risk;
}

export function spreadForecast(fs: FireSpreadForecast, horizonMin: number): SpreadForecast {
    const { grid } = fs;
    const dlat = grid.cellSizeM / M_PER_DEG_LAT;
    const dlon = grid.cellSizeM / metersPerDegLon(grid.southWest.lat + (grid.rows * dlat) / 2);
    const cells: [number, number, number][] = [];
    for (let i = 0; i < fs.arrivalMin.length; i++) {
        const m = fs.arrivalMin[i];
        if (m === null || m === undefined) continue;
        const row = Math.floor(i / grid.cols);
        const col = i % grid.cols;
        cells.push([
            grid.southWest.lat + (row + 0.5) * dlat,
            grid.southWest.lng + (col + 0.5) * dlon,
            Math.max(0, Math.round(m)),
        ]);
    }
    const track = fs.track.map((t) => ({
        at: toLatLon(t.center),
        atMin: t.atMin,
        radiusM: Math.sqrt((t.areaHa * 10_000) / Math.PI),
    }));
    return {
        origin: track[0]?.at ?? toLatLon(grid.southWest),
        headingDeg: fs.headingDeg ?? 0,
        horizonMin,
        cellM: grid.cellSizeM,
        cells,
        track,
        isochrones: fs.isochrones.map((iso) => ({
            atMin: iso.atMin,
            rings: iso.polygons.map((p) => p.outer.map(toLatLon)),
        })),
    };
}

function attackLabel(rank: number): string {
    return rank >= 1 && rank <= 26 ? String.fromCharCode(64 + rank) : String(rank);
}

export function livePlans(
    result: PlannerResult,
    geography: ZoneGeography,
    assignments: ResponderAssignment[],
): { civilian: CivilianPlan; responder: ResponderPlan } {
    const generatedAt = Date.parse(result.generatedAt);
    const spread = spreadForecast(result.fireSpread, result.horizonMin);
    const areas = new Map(geography.civilianAreas.map((a) => [a.id, a]));
    const roadNames = new Map(geography.roads.map((r) => [r.id, r.name]));
    const safeNames = new Map(geography.safeZones.map((s) => [s.id, s.name]));

    const impacts: CivilianImpact[] = result.civilianImpacts
        .flatMap((c) => {
            const area = areas.get(c.civilianAreaId);
            if (!area) return [];
            return [
                {
                    communityId: c.civilianAreaId,
                    name: c.name,
                    lat: area.center.lat,
                    lon: area.center.lng,
                    population: c.population,
                    arrivalMin: c.impactMin === null ? null : Math.max(0, Math.round(c.impactMin)),
                    urgency: c.gradient,
                },
            ];
        })
        .sort((a, b) => b.urgency - a.urgency);

    const routes: EvacuationRoute[] = result.evacuationRoutes.flatMap((r) => {
        if (r.status === 'no_safe_route' || r.path.length < 2) return [];
        const road = r.roadIds.map((id) => roadNames.get(id)).find((n) => n);
        const safeZoneId = r.destination?.safeZoneId ?? '';
        const alternate = r.alternate?.path.length ? r.alternate.path.map(toLatLon) : null;
        return [
            {
                id: `route-${r.civilianAreaId}`,
                name: road
                    ? `Via ${road}`
                    : `To ${safeNames.get(safeZoneId) ?? 'the nearest exit'}`,
                communityId: r.civilianAreaId,
                safeZoneId,
                path: r.path.map(toLatLon),
                distanceKm: Math.round(r.distanceM / 100) / 10,
                etaMin: Math.round(r.etaMin),
                status: r.status,
                alternate: alternate && alternate.length >= 2 ? alternate : null,
            },
        ];
    });

    const dropSites: DropSite[] = [...result.attackZones]
        .sort((a, b) => a.rank - b.rank)
        .map((z) => ({
            id: z.id,
            name: `Attack zone ${attackLabel(z.rank)}`,
            lat: z.center.lat,
            lon: z.center.lng,
            radiusM: Math.round(z.radiusM),
            purpose: `${z.tactic === 'direct' ? 'Direct attack' : 'Indirect attack'} · fire in ${minutes(z.fireArrivalMin)}`,
            crews: assignments.filter((a) => a.jobId === result.jobId && a.attackZoneId === z.id)
                .length,
        }));

    return {
        civilian: { generatedAt, spread, impacts, routes },
        responder: { generatedAt, spread, dropSites },
    };
}

export interface LiveAlert {
    approval: Approval;
    number: number;
    areaName: string;
    severity: CivilianAlertDraft['severity'];
    recipients: number;
    firstBody: string | null;
    reason: string;
}

/** Pending civilian alerts, oldest first, each named by its area. */
export function pendingAlerts(approvals: Approval[], areas: CivilianArea[]): LiveAlert[] {
    const names = new Map(areas.map((a) => [a.id, a.name]));
    return approvals
        .flatMap((a) => {
            if (a.state !== 'pending' || a.draft.kind !== 'civilian_alert') return [];
            const draft = a.draft;
            return [
                {
                    approval: a,
                    number: a.number,
                    areaName: names.get(draft.civilianAreaId) ?? draft.civilianAreaId,
                    severity: draft.severity,
                    recipients: draft.recipients.length,
                    firstBody: draft.recipients[0]?.body ?? null,
                    reason: a.reason,
                },
            ];
        })
        .sort((a, b) => a.number - b.number);
}
