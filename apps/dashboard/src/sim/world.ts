import {
    bearingDeg,
    cellCenter,
    centroid,
    computeCoverage,
    distanceM,
    makeGrid,
    offset,
    polygonAreaKm2,
    projector,
} from './geo';
import type {
    Community,
    Drone,
    EdgeServer,
    EdgeServerHealth,
    Hazard,
    LatLon,
    SafeZone,
    WatchZone,
    ZoneStatus,
} from './types';

// Builders for dummy watch zones: grids, edge server suggestions, drone pairing and the
// hidden "truth" a scan uncovers.

export function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

export function hash(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

let counter = 0;
export function newId(prefix: string): string {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
}

export function hex(rand: () => number, n: number): string {
    return Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compass(deg: number): string {
    return COMPASS[Math.round(deg / 45) % 8]!;
}

const DRONE_NAMES = [
    'Kestrel',
    'Osprey',
    'Harrier',
    'Merlin',
    'Swift',
    'Condor',
    'Falcon',
    'Heron',
    'Kite',
    'Raven',
    'Hobby',
    'Shrike',
];

export const SERVER_RADIUS_M = 1500;

export function serverHealth(rand: () => number): EdgeServerHealth {
    return {
        cpuPct: Math.round(14 + rand() * 30),
        memoryPct: Math.round(28 + rand() * 30),
        temperatureC: Math.round(31 + rand() * 14),
        latencyMs: Math.round(8 + rand() * 30),
        uptimeH: Math.round(20 + rand() * 900),
        firmware: `edge-os 2.${Math.floor(3 + rand() * 3)}.${Math.floor(rand() * 9)}`,
        power: (['grid', 'solar', 'battery'] as const)[Math.floor(rand() * 3)]!,
    };
}

function serverName(zone: Pick<WatchZone, 'boundary'>, at: LatLon, taken: string[]): string {
    const dir = compass(bearingDeg(centroid(zone.boundary), at));
    let n = 1;
    while (taken.includes(`${dir}-${n}`)) n += 1;
    return `${dir}-${n}`;
}

/**
 * Suggested edge server sites: greedy set cover. Each pick is the candidate site that
 * reaches the most uncovered forest, until coverage passes the target.
 */
export function suggestServers(zone: WatchZone, targetPct = 92): EdgeServer[] {
    const rand = seeded(hash(zone.id) ^ zone.boundary.length);
    const { grid } = zone;
    const R = SERVER_RADIUS_M;
    const project = projector([(grid.south + grid.north) / 2, (grid.west + grid.east) / 2]);
    const cells: [number, number][] = [];
    const candidates: { at: LatLon; xy: [number, number] }[] = [];
    for (let i = 0; i < grid.inZone.length; i++) {
        if (!grid.inZone[i]) continue;
        const at = cellCenter(grid, i);
        const xy = project(at);
        cells.push(xy);
        const row = Math.floor(i / grid.cols);
        if (row % 3 === 1 && (i % grid.cols) % 3 === 1) candidates.push({ at, xy });
    }
    const covered = new Uint8Array(cells.length);
    let count = 0;
    const cover = ([x, y]: [number, number], apply: boolean) => {
        let gain = 0;
        for (let k = 0; k < cells.length; k++) {
            if (covered[k]) continue;
            const dx = cells[k]![0] - x;
            if (dx > R || dx < -R) continue;
            const dy = cells[k]![1] - y;
            if (dx * dx + dy * dy > R * R) continue;
            gain += 1;
            if (apply) covered[k] = 1;
        }
        if (apply) count += gain;
        return gain;
    };
    for (const s of zone.servers) if (s.status === 'deployed') cover(project([s.lat, s.lon]), true);
    const need = Math.ceil((targetPct / 100) * cells.length);
    const picks: LatLon[] = [];
    for (let guard = 0; guard < 40; guard++) {
        if (count >= need) break;
        let best = candidates[0];
        let bestGain = 0;
        for (const c of candidates) {
            const gain = cover(c.xy, false);
            if (gain > bestGain) {
                bestGain = gain;
                best = c;
            }
        }
        if (!best || bestGain < Math.max(3, cells.length * 0.01)) break;
        cover(best.xy, true);
        picks.push(best.at);
    }
    const names = zone.servers.map((s) => s.name);
    return picks.map((at) => {
        const name = serverName(zone, at, names);
        names.push(name);
        return {
            id: newId('es'),
            name,
            lat: at[0],
            lon: at[1],
            radiusM: SERVER_RADIUS_M,
            status: 'pending' as const,
            health: serverHealth(rand),
        };
    });
}

export function pairDrone(
    zone: WatchZone,
    server: EdgeServer,
    rand: () => number = Math.random,
): Drone {
    const used = new Set(zone.drones.map((d) => d.name));
    const base = DRONE_NAMES.find((n) => !used.has(n)) ?? `Drone ${zone.drones.length + 1}`;
    return {
        id: `${hex(rand, 8)}-${hex(rand, 4)}-${hex(rand, 4)}`,
        name: base,
        serverId: server.id,
        model: rand() > 0.4 ? 'Ember Scout X2' : 'Ember Scout X1',
        firmware: `flight 1.${Math.floor(6 + rand() * 4)}.${Math.floor(rand() * 9)}`,
        pairedAt: Date.now(),
    };
}

/** Smooth, repeatable noise in 0..1 over the grid, so risk edges look natural. */
function noise(row: number, col: number, seed: number): number {
    const a = Math.sin(row * 0.61 + seed) * Math.cos(col * 0.47 - seed * 0.3);
    const b = Math.sin((row + col) * 0.23 + seed * 1.7);
    return 0.5 + 0.32 * a + 0.18 * b;
}

/** What a drone sees in one cell: 1 no risk, 2 at risk, 3 on fire. */
export function cellTruth(
    zone: Pick<WatchZone, 'grid' | 'hazards' | 'id'>,
    index: number,
): 1 | 2 | 3 {
    const at = cellCenter(zone.grid, index);
    const n = noise(Math.floor(index / zone.grid.cols), index % zone.grid.cols, hash(zone.id) % 97);
    let level: 1 | 2 | 3 = 1;
    for (const h of zone.hazards) {
        const d = distanceM(at, h.at);
        if (h.kind === 'fire') {
            if (d < h.radiusM * (0.7 + 0.5 * n)) return 3;
            if (d < h.radiusM * (1.9 + 1.2 * n)) level = 2;
        } else if (d < h.radiusM * (0.6 + 0.6 * n)) {
            level = 2;
        }
    }
    return level;
}

/** Fills the risk map as if a full scan just finished. */
export function mapEverything(zone: WatchZone): void {
    for (let i = 0; i < zone.risk.length; i++) {
        zone.risk[i] = zone.grid.inZone[i] ? cellTruth(zone, i) : 0;
    }
    zone.riskVersion += 1;
}

export function riskCounts(zone: WatchZone): { mapped: number; atRisk: number; onFire: number } {
    let mapped = 0;
    let atRisk = 0;
    let onFire = 0;
    for (let i = 0; i < zone.risk.length; i++) {
        const r = zone.risk[i]!;
        if (!r) continue;
        mapped += 1;
        if (r === 2) atRisk += 1;
        if (r === 3) onFire += 1;
    }
    return { mapped, atRisk, onFire };
}

export function setupStep(zone: WatchZone): 1 | 2 | 3 | null {
    if (!zone.servers.some((s) => s.status === 'deployed')) return 2;
    if (zone.drones.length === 0) return 3;
    return null;
}

export function zoneStatus(zone: WatchZone): ZoneStatus {
    if (setupStep(zone)) return 'setup';
    const { atRisk, onFire } = riskCounts(zone);
    if (onFire > 0) return 'on_fire';
    if (atRisk > 0) return 'at_risk';
    return zone.lastScanAt === null && !zone.scan ? 'awaiting' : 'healthy';
}

export function deployedCoverage(zone: WatchZone): number {
    return computeCoverage(
        zone.grid,
        zone.servers.filter((s) => s.status === 'deployed'),
    ).pct;
}

const TOWNS = [
    'Pine Hollow',
    'Cedar Flat',
    'Granite Springs',
    'Oak Terrace',
    'Juniper Bend',
    'Manzanita',
    'Fern Gully',
    'Aspen Rise',
];
const SHELTERS = [
    'Valley High School',
    'Ridge Community Hall',
    'Lakeside Elementary',
    'County Fairgrounds',
];

/** Dummy towns and shelters around a zone the operator drew. */
export function surroundings(
    boundary: LatLon[],
    seed: string,
): { communities: Community[]; safeZones: SafeZone[] } {
    const rand = seeded(hash(seed));
    const center = centroid(boundary);
    const radius = Math.sqrt((polygonAreaKm2(boundary) * 1e6) / Math.PI);
    const communities = [0, 1, 2].map((k) => {
        const angle = (k * 2 * Math.PI) / 3 + rand() * 0.9;
        const d = radius + 800 + rand() * 1600;
        const [lat, lon] = offset(center, Math.cos(angle) * d, Math.sin(angle) * d);
        return {
            id: `c-${seed}-${k}`,
            name: TOWNS[(hash(seed) + k) % TOWNS.length]!,
            lat,
            lon,
            population: Math.round(1500 + rand() * 16000),
        };
    });
    const safeZones = communities.slice(0, 2).map((c, k) => {
        const away = (bearingDeg(center, [c.lat, c.lon]) * Math.PI) / 180;
        const [lat, lon] = offset([c.lat, c.lon], Math.cos(away) * 2600, Math.sin(away) * 2600);
        return {
            id: `s-${seed}-${k}`,
            name: SHELTERS[(hash(seed) + k) % SHELTERS.length]!,
            lat,
            lon,
        };
    });
    return { communities, safeZones };
}

export function buildZone(input: {
    id: string;
    name: string;
    region: string;
    boundary: LatLon[];
    createdAt?: number;
    hazards?: Hazard[];
    windFromDeg?: number;
    communities?: Community[];
    safeZones?: SafeZone[];
}): WatchZone {
    const grid = makeGrid(input.boundary);
    const around =
        input.communities && input.safeZones
            ? { communities: input.communities, safeZones: input.safeZones }
            : surroundings(input.boundary, input.id);
    return {
        id: input.id,
        name: input.name,
        region: input.region,
        createdAt: input.createdAt ?? Date.now(),
        boundary: input.boundary,
        areaKm2: Math.round(polygonAreaKm2(input.boundary) * 10) / 10,
        grid,
        servers: [],
        drones: [],
        schedule: { enabled: false, everyHours: 12, nextAt: null },
        lastScanAt: null,
        scan: null,
        risk: new Uint8Array(grid.rows * grid.cols),
        riskVersion: 0,
        hazards: input.hazards ?? defaultHazards(input.boundary, input.id),
        windFromDeg: input.windFromDeg ?? 40,
        communities: around.communities,
        safeZones: around.safeZones,
        civilianPlan: null,
        responderPlan: null,
        planning: { civilian: false, responder: false },
        checkIns: { safe: 0, total: 0 },
        reports: [],
        responders: [],
        blasts: [],
    };
}

/** A drawn zone gets a couple of dry patches for its first scan to find. */
function defaultHazards(boundary: LatLon[], seed: string): Hazard[] {
    const rand = seeded(hash(seed) ^ 7);
    const grid = makeGrid(boundary, 250);
    const inside: LatLon[] = [];
    for (let i = 0; i < grid.inZone.length; i++)
        if (grid.inZone[i]) inside.push(cellCenter(grid, i));
    const pick = () => inside[Math.floor(rand() * inside.length)] ?? centroid(boundary);
    return [
        { at: pick(), kind: 'risk', radiusM: 420 },
        { at: pick(), kind: 'risk', radiusM: 300 },
    ];
}

/**
 * The "forest detection" fit: densify the outline and pull each vertex along the
 * forest edge. Stands in for the YOLO + open data model.
 */
export function autoFit(points: LatLon[], seed = 1): { from: LatLon[]; to: LatLon[] } {
    if (points.length < 3) return { from: points, to: points };
    const center = centroid(points);
    const project = projector(center);
    const kLat = 1 / 111_320;
    const kLon = 1 / (111_320 * Math.cos((center[0] * Math.PI) / 180));
    const dense: [number, number][] = [];
    const per = Math.max(2, Math.round(28 / points.length));
    points.forEach((p, i) => {
        const a = project(p);
        const b = project(points[(i + 1) % points.length]!);
        for (let k = 0; k < per; k++) {
            const t = k / per;
            dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    });
    const rand = seeded(seed);
    const phase = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const back = ([x, y]: [number, number], k = 1): LatLon => [
        center[0] + y * k * kLat,
        center[1] + x * k * kLon,
    ];
    return {
        from: dense.map((p) => back(p)),
        to: dense.map(([x, y]) => {
            const angle = Math.atan2(y, x);
            const wobble =
                1 +
                0.09 * Math.sin(angle * 3 + phase[0]!) +
                0.05 * Math.sin(angle * 7 + phase[1]!) +
                0.03 * Math.sin(angle * 13 + phase[2]!);
            return back([x, y], wobble);
        }),
    };
}

/** Moves a server to a new spot, recomputing its compass name. */
export function renameServer(zone: WatchZone, server: EdgeServer): EdgeServer {
    const others = zone.servers.filter((s) => s.id !== server.id).map((s) => s.name);
    return { ...server, name: serverName(zone, [server.lat, server.lon], others) };
}
