import { bearingDeg, cellCenter, centroid, distanceM, offset } from './geo';
import { hash } from './world';
import type {
    CivilianImpact,
    CivilianPlan,
    DropSite,
    EvacuationRoute,
    LatLon,
    ResponderPlan,
    SpreadForecast,
    WatchZone,
} from './types';

// Dummy planners. They stand in for services/planner: same shapes of answer
// (spread forecast, civilian impact, evacuation routes, attack zones), simpler math.

const HEAD_M_PER_MIN = 22;
const FLANK_M_PER_MIN = 5.5;
const BACK_M_PER_MIN = 2.2;
const HORIZON_MIN = 360;
const CELL_M = 120;

/** Where the fire is, or would most likely start: burning cells, then at-risk cells, then hazards. */
function ignition(zone: WatchZone): LatLon {
    const pick = (level: number) => {
        const cells: LatLon[] = [];
        for (let i = 0; i < zone.risk.length; i++)
            if (zone.risk[i] === level) cells.push(cellCenter(zone.grid, i));
        return cells.length ? centroid(cells) : null;
    };
    return pick(3) ?? pick(2) ?? zone.hazards[0]?.at ?? centroid(zone.boundary);
}

export function spreadForecast(zone: WatchZone): SpreadForecast {
    const origin = ignition(zone);
    const headingDeg = (zone.windFromDeg + 180) % 360;
    const theta = (headingDeg * Math.PI) / 180;
    const reach = HEAD_M_PER_MIN * HORIZON_MIN;
    const cells: [number, number, number][] = [];
    for (let y = -reach; y <= reach; y += CELL_M) {
        for (let x = -reach; x <= reach; x += CELL_M) {
            const u = x * Math.sin(theta) + y * Math.cos(theta);
            const v = x * Math.cos(theta) - y * Math.sin(theta);
            const along = u >= 0 ? u / HEAD_M_PER_MIN : u / BACK_M_PER_MIN;
            const minutes = Math.sqrt(along * along + (v / FLANK_M_PER_MIN) ** 2);
            if (minutes <= HORIZON_MIN) {
                const [lat, lon] = offset(origin, y, x);
                cells.push([lat, lon, Math.round(minutes)]);
            }
        }
    }
    const track = [0, 60, 120, 180, 240, 300, 360].map((atMin) => {
        const d = HEAD_M_PER_MIN * atMin;
        return {
            at: offset(origin, Math.cos(theta) * d, Math.sin(theta) * d),
            atMin,
            radiusM: 180 + FLANK_M_PER_MIN * atMin * 1.1,
        };
    });
    return { origin, headingDeg, horizonMin: HORIZON_MIN, cellM: CELL_M, cells, track };
}

function arrivalNear(spread: SpreadForecast, at: LatLon, withinM: number): number | null {
    let best: number | null = null;
    for (const [lat, lon, m] of spread.cells) {
        if (best !== null && m >= best) continue;
        if (distanceM(at, [lat, lon]) <= withinM) best = m;
    }
    return best;
}

/** A gentle curve from a to b that bows away from the fire. */
function curvedPath(a: LatLon, b: LatLon, fire: LatLon): LatLon[] {
    const mid = centroid([a, b]);
    const away = (bearingDeg(fire, mid) * Math.PI) / 180;
    const bow = distanceM(a, b) * 0.28;
    const ctrl = offset(mid, Math.cos(away) * bow, Math.sin(away) * bow);
    return Array.from({ length: 17 }, (_, i) => {
        const t = i / 16;
        const k0 = (1 - t) ** 2;
        const k1 = 2 * (1 - t) * t;
        const k2 = t * t;
        return [
            k0 * a[0] + k1 * ctrl[0] + k2 * b[0],
            k0 * a[1] + k1 * ctrl[1] + k2 * b[1],
        ] as LatLon;
    });
}

function pathKm(path: LatLon[]): number {
    let m = 0;
    for (let i = 1; i < path.length; i++) m += distanceM(path[i - 1]!, path[i]!);
    return Math.round(m / 100) / 10;
}

export function civilianPlan(zone: WatchZone): CivilianPlan {
    const spread = spreadForecast(zone);
    const impacts: CivilianImpact[] = zone.communities
        .map((c) => {
            const arrivalMin = arrivalNear(spread, [c.lat, c.lon], 900);
            return {
                communityId: c.id,
                name: c.name,
                lat: c.lat,
                lon: c.lon,
                population: c.population,
                arrivalMin,
                urgency: arrivalMin === null ? 0 : Math.max(0.12, 1 - arrivalMin / HORIZON_MIN),
            };
        })
        .sort((a, b) => b.urgency - a.urgency);

    const routes: EvacuationRoute[] = impacts
        .filter((c) => c.urgency > 0)
        .map((c) => {
            const from: LatLon = [c.lat, c.lon];
            const fleeing = bearingDeg(spread.origin, from);
            const safe = [...zone.safeZones].sort((a, b) => {
                const da = Math.abs(
                    ((bearingDeg(from, [a.lat, a.lon]) - fleeing + 540) % 360) - 180,
                );
                const db = Math.abs(
                    ((bearingDeg(from, [b.lat, b.lon]) - fleeing + 540) % 360) - 180,
                );
                return da - db;
            })[0];
            if (!safe) return null;
            const path = curvedPath(from, [safe.lat, safe.lon], spread.origin);
            const km = pathKm(path);
            return {
                id: `route-${c.communityId}`,
                name: `Route ${(hash(c.communityId) % 40) + 2}`,
                communityId: c.communityId,
                safeZoneId: safe.id,
                path,
                distanceKm: km,
                etaMin: Math.max(4, Math.round((km / 32) * 60)),
            };
        })
        .filter((r): r is EvacuationRoute => r !== null);

    return { generatedAt: Date.now(), spread, impacts, routes };
}

export function responderPlan(zone: WatchZone): ResponderPlan {
    const spread = spreadForecast(zone);
    const theta = (spread.headingDeg * Math.PI) / 180;
    const along = (min: number, sideM: number): LatLon => {
        const d = HEAD_M_PER_MIN * min;
        const head = offset(spread.origin, Math.cos(theta) * d, Math.sin(theta) * d);
        return offset(head, -Math.sin(theta) * sideM, Math.cos(theta) * sideM);
    };
    const flank = (min: number) => FLANK_M_PER_MIN * min + 450;
    const sites: Omit<DropSite, 'id' | 'name'>[] = [
        { ...ll(along(75, 0)), radiusM: 520, purpose: 'Head containment line', crews: 3 },
        { ...ll(along(40, flank(40))), radiusM: 380, purpose: 'Flank anchor, right', crews: 2 },
        { ...ll(along(40, -flank(40))), radiusM: 380, purpose: 'Flank anchor, left', crews: 2 },
        { ...ll(along(-15, 900)), radiusM: 300, purpose: 'Water drop staging', crews: 1 },
    ];
    return {
        generatedAt: Date.now(),
        spread,
        dropSites: sites.map((s, i) => ({
            ...s,
            id: `drop-${i + 1}`,
            name: `Drop site ${String.fromCharCode(65 + i)}`,
        })),
    };
}

function ll([lat, lon]: LatLon): { lat: number; lon: number } {
    return { lat, lon };
}
