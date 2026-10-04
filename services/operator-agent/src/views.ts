import type {
    AttackZone,
    CivilianArea,
    CivilianImpact,
    EvacuationPath,
    EvacuationRoute,
    LatLng,
    PlannerResult,
    Road,
    SafeZone,
    SectorRisk,
} from '@ember/contracts';

/**
 * Compact, model-sized views of planner output. They reshape and name what the planner computed;
 * every number in them is the planner's (rounded), never derived from geometry here, except
 * the compass word for a direction the planner's own points give.
 */

export type Geography = {
    roads: Road[];
    civilianAreas: CivilianArea[];
    safeZones: SafeZone[];
};

const COMPASS = [
    'north',
    'northeast',
    'east',
    'southeast',
    'south',
    'southwest',
    'west',
    'northwest',
];

export function compass(deg: number): string {
    return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export function bearing(a: LatLng, b: LatLng): number {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    const x =
        Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
        Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    return (((Math.atan2(y, x) / rad) % 360) + 360) % 360;
}

export const attackZoneLabel = (rank: number) =>
    rank <= 26 ? String.fromCharCode(64 + rank) : `${rank}`;

export function roadNames(roads: Road[], ids: string[]): string[] {
    const names: string[] = [];
    for (const id of ids) {
        const road = roads.find((r) => r.id === id);
        const name = road?.name ?? (road ? `unnamed ${road.kind}` : id);
        if (names.at(-1) !== name) names.push(name);
    }
    return [...new Set(names)];
}

const round = (v: number | null, digits = 0) =>
    v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;

export type PathView = {
    status: EvacuationPath['status'];
    via: string[];
    destination: string | null;
    etaMin: number;
    clearanceMin: number | null;
    distanceKm: number;
    /** Direction of the destination from the area's centre. */
    heads: string | null;
};

function pathView(p: EvacuationPath, from: LatLng | null, geo: Geography): PathView {
    const zone = geo.safeZones.find((z) => z.id === p.destination?.safeZoneId);
    return {
        status: p.status,
        via: roadNames(geo.roads, p.roadIds),
        destination: zone?.name ?? (p.destination ? 'a road exit out of the area' : null),
        etaMin: round(p.etaMin)!,
        clearanceMin: round(p.clearanceMin),
        distanceKm: round(p.distanceM / 1000, 1)!,
        heads: from && p.destination ? compass(bearing(from, p.destination.location)) : null,
    };
}

export type RouteView = PathView & {
    civilianAreaId: string;
    area: string;
    alternate: PathView | null;
};

export function routeView(r: EvacuationRoute, geo: Geography): RouteView {
    const area = geo.civilianAreas.find((a) => a.id === r.civilianAreaId);
    const from = area?.center ?? null;
    return {
        civilianAreaId: r.civilianAreaId,
        area: area?.name ?? r.civilianAreaId,
        ...pathView(r, from, geo),
        alternate: r.alternate ? pathView(r.alternate, from, geo) : null,
    };
}

export type ImpactView = {
    civilianAreaId: string;
    area: string;
    population: number;
    severity: CivilianImpact['severity'];
    fireArrivalMin: number | null;
    exposedPct: number;
};

export function impactView(i: CivilianImpact): ImpactView {
    return {
        civilianAreaId: i.civilianAreaId,
        area: i.name,
        population: Math.round(i.population),
        severity: i.severity,
        fireArrivalMin: round(i.impactMin),
        exposedPct: Math.round(i.exposedFraction * 100),
    };
}

export type AttackZoneView = {
    id: string;
    label: string;
    rank: number;
    tactic: AttackZone['tactic'];
    fireArrivalMin: number;
    accessMin: number | null;
    spreadRateMpm: number;
    dropSiteRoad: string | null;
    approachVia: string[];
    approachFrom: string | null;
    protects: string[];
    protectedPopulation: number;
};

export function attackZoneView(z: AttackZone, geo: Geography): AttackZoneView {
    const last = z.approach?.roadIds.at(-1);
    return {
        id: z.id,
        label: attackZoneLabel(z.rank),
        rank: z.rank,
        tactic: z.tactic,
        fireArrivalMin: round(z.fireArrivalMin)!,
        accessMin: round(z.accessMin),
        spreadRateMpm: round(z.spreadRateMpm, 1)!,
        dropSiteRoad: last ? (roadNames(geo.roads, [last])[0] ?? null) : null,
        approachVia: z.approach ? roadNames(geo.roads, z.approach.roadIds) : [],
        approachFrom:
            z.approach?.arrivesFromDeg != null ? compass(z.approach.arrivesFromDeg) : null,
        protects: z.protects.map((id) => geo.civilianAreas.find((a) => a.id === id)?.name ?? id),
        protectedPopulation: Math.round(z.protectedPopulation),
    };
}

export type SectorView = {
    id: string;
    rank: number;
    score: number;
    band: SectorRisk['band'];
    drivers: string[];
    population: number;
    fireArrivalMin: number | null;
    factors: SectorRisk['factors'];
};

export function sectorView(s: SectorRisk): SectorView {
    return {
        id: s.id,
        rank: s.rank,
        score: s.score,
        band: s.band,
        drivers: s.drivers,
        population: Math.round(s.population),
        fireArrivalMin: round(s.fireArrivalMin),
        factors: s.factors,
    };
}

export function fireView(result: PlannerResult) {
    const f = result.fireSpread;
    return {
        headingDeg: round(f.headingDeg),
        heading: f.headingDeg === null ? null : compass(f.headingDeg),
        maxSpreadMpm: round(f.maxSpreadMpm, 1),
        isochrones: f.isochrones.map((i) => ({ atMin: i.atMin, areaHa: round(i.areaHa) })),
        horizonMin: result.horizonMin,
    };
}

/** Everything a model needs to talk about a plan, without the per-cell grid. */
export function planView(result: PlannerResult, geo: Geography) {
    return {
        jobId: result.jobId,
        generatedAt: result.generatedAt,
        assumptions: result.assumptions,
        fire: fireView(result),
        attackZones: result.attackZones.map((z) => attackZoneView(z, geo)),
        civilianImpacts: result.civilianImpacts.map(impactView),
        evacuationRoutes: result.evacuationRoutes.map((r) => routeView(r, geo)),
        topSectors: result.sectorRisks.slice(0, 5).map(sectorView),
    };
}

/** Road ids every part of a plan relies on, with what relies on them. */
export function usesOfRoads(result: PlannerResult, roadIds: string[]) {
    const hit = (ids: string[] | undefined) => !!ids?.some((id) => roadIds.includes(id));
    return {
        attackZones: result.attackZones.filter((z) => hit(z.approach?.roadIds)).map((z) => z.id),
        evacuationRoutes: result.evacuationRoutes
            .filter((r) => hit(r.roadIds) || hit(r.alternate?.roadIds))
            .map((r) => r.civilianAreaId),
    };
}
