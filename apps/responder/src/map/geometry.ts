import type {
    AttackZone,
    FuelType,
    PolygonShape,
    RiskLevel,
    RoadKind,
    ResponderZoneBundle,
} from '@ember/contracts';
import {
    boundsOf,
    centroid,
    makeProjection,
    pathD,
    type Bounds,
    type Point,
    type Projection,
} from '../lib/geo';
import { fuelRuns } from '../lib/terrain';
import { sorted } from "../lib/sorted";

type Risk = Exclude<RiskLevel, 'none'>;

/** A bundle projected once into local metres, ready to draw at any zoom. */
export type ZoneGeometry = {
    proj: Projection;
    bounds: Bounds;
    boundary: string;
    fuel: { x: number; y: number; w: number; h: number; fuel: FuelType }[];
    roads: { id: string; d: string; kind: RoadKind }[];
    risk: { id: string; risk: Risk; d: string }[];
    detections: { id: string; risk: Risk; p: Point }[];
    /** Outermost first so inner bands paint over outer ones. */
    isochrones: { atMin: number; d: string; label: Point }[];
    track: string;
    head: { p: Point; deg: number } | null;
    attack: { zone: AttackZone; p: Point; r: number; drop: Point }[];
    safeZones: { id: string; name: string; p: Point }[];
    stations: { id: string; name: string; p: Point }[];
    places: { id: string; name: string; p: Point; population: number }[];
};

function shapeD(shape: PolygonShape, toXY: Projection['toXY']): string {
    return [shape.outer, ...shape.holes].map((ring) => pathD(ring.map(toXY), true)).join('');
}

export function buildGeometry(b: ResponderZoneBundle): ZoneGeometry {
    const proj = makeProjection(centroid(b.boundary));
    const { toXY } = proj;
    const boundaryXY = b.boundary.map(toXY);
    const plan = b.plan;
    const heading = plan?.headingDeg ?? null;

    const fuel: ZoneGeometry['fuel'] = [];
    if (b.terrain) {
        const { runs, step } = fuelRuns(b.terrain);
        const sw = toXY(b.terrain.southWest);
        const s = b.terrain.cellSizeM;
        for (const run of runs) {
            fuel.push({
                x: sw.x + run.col * s,
                y: sw.y - (run.row + step) * s,
                w: run.len * s,
                h: step * s,
                fuel: run.fuel,
            });
        }
    }

    const isochrones = sorted(plan?.isochrones ?? [], (a, c) => c.atMin - a.atMin).map((iso) => {
            const pts = iso.polygons.flatMap((p) => p.outer.map(toXY));
            const h = ((heading ?? 0) * Math.PI) / 180;
            const dir = { x: Math.sin(h), y: -Math.cos(h) };
            let label = pts[0] ?? { x: 0, y: 0 };
            let best = -Infinity;
            for (const p of pts) {
                const d = p.x * dir.x + p.y * dir.y;
                if (d > best) {
                    best = d;
                    label = p;
                }
            }
            return {
                atMin: iso.atMin,
                d: iso.polygons.map((p) => shapeD(p, toXY)).join(''),
                label,
            };
        });

    const trackXY = (plan?.track ?? []).map((t) => toXY(t.center));
    const last = trackXY[trackXY.length - 1];

    return {
        proj,
        bounds: boundsOf(boundaryXY),
        boundary: pathD(boundaryXY, true),
        fuel,
        roads: b.roads.map((r) => ({ id: r.id, d: pathD(r.path.map(toXY), false), kind: r.kind })),
        risk: sorted(b.riskZones, (a, c) => Number(a.risk === "on_fire") - Number(c.risk === "on_fire")).map((z) => ({ id: z.id, risk: z.risk, d: pathD(z.polygon.map(toXY), true) })),
        detections: b.detections.map((d) => ({ id: d.id, risk: d.risk, p: toXY(d.center) })),
        isochrones,
        track: pathD(trackXY, false),
        head: last && heading !== null ? { p: last, deg: heading } : null,
        attack: sorted(plan?.attackZones ?? [], (a, c) => c.rank - a.rank).map((zone) => ({
                zone,
                p: toXY(zone.center),
                r: zone.radiusM,
                drop: toXY(zone.dropSite),
            })),
        safeZones: b.safeZones.map((s) => ({ id: s.id, name: s.name, p: toXY(s.location) })),
        stations: b.stations.map((s) => ({ id: s.id, name: s.name, p: toXY(s.location) })),
        places: b.civilianAreas.map((a) => ({
            id: a.id,
            name: a.name,
            p: toXY(a.center),
            population: a.population,
        })),
    };
}

/** The attack zone under a tapped world point, preferring the best-ranked when circles overlap. */
export function hitAttack(g: ZoneGeometry, p: Point, slopM: number): AttackZone | null {
    let hit: AttackZone | null = null;
    for (const a of g.attack) {
        if (Math.hypot(a.p.x - p.x, a.p.y - p.y) <= a.r + slopM) {
            if (!hit || a.zone.rank < hit.rank) hit = a.zone;
        }
    }
    return hit;
}
