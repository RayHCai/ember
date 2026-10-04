import type { LatLng } from '@ember/contracts';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
const M_PER_DEG = EARTH_RADIUS_M * RAD;

/** Metres east (x) and north (y) of a projection's origin. */
export type Point = { x: number; y: number };

export type Circle = { center: LatLng; radiusM: number };

export type Projection = { toXY(p: LatLng): Point; toLatLng(p: Point): LatLng };

/** Equirectangular around `origin`: accurate to well under 1% across a watch zone. */
export function projection(origin: LatLng): Projection {
    const kx = M_PER_DEG * Math.cos(origin.lat * RAD);
    return {
        toXY: (p) => ({ x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * M_PER_DEG }),
        toLatLng: ({ x, y }) => ({ lat: origin.lat + y / M_PER_DEG, lng: origin.lng + x / kx }),
    };
}

/** Area centroid of a ring; the vertex mean when the ring has no area. */
export function centroid(ring: LatLng[]): LatLng {
    const mean = {
        lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
        lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length,
    };
    const proj = projection(mean);
    const pts = ring.map(proj.toXY);
    let area2 = 0;
    let cx = 0;
    let cy = 0;
    for (const [i, p] of pts.entries()) {
        const q = pts[(i + 1) % pts.length]!;
        const cross = p.x * q.y - q.x * p.y;
        area2 += cross;
        cx += (p.x + q.x) * cross;
        cy += (p.y + q.y) * cross;
    }
    if (Math.abs(area2) < 1e-6) return mean;
    return proj.toLatLng({ x: cx / (3 * area2), y: cy / (3 * area2) });
}

/** Even-odd rule; `ring` does not repeat its first point. */
export function insideRing(p: Point, ring: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

const MAX_CELLS = 40_000;

/** The boundary's bbox in cells; `inZone` marks cells whose centre lies inside the ring. */
type Grid = {
    proj: Projection;
    minX: number;
    minY: number;
    cellM: number;
    cols: number;
    rows: number;
    inZone: Uint8Array;
    inZoneCount: number;
};

function grid(boundary: LatLng[], radiusM: number): Grid {
    const proj = projection(centroid(boundary));
    const ring = boundary.map(proj.toXY);
    const minX = Math.min(...ring.map((p) => p.x));
    const minY = Math.min(...ring.map((p) => p.y));
    const width = Math.max(...ring.map((p) => p.x)) - minX;
    const height = Math.max(...ring.map((p) => p.y)) - minY;
    let cellM = Math.min(150, Math.max(15, radiusM / 8));
    let cols: number;
    let rows: number;
    for (;;) {
        cols = Math.max(1, Math.ceil(width / cellM));
        rows = Math.max(1, Math.ceil(height / cellM));
        if (cols * rows < MAX_CELLS) break;
        cellM *= 1.1;
    }
    const inZone = new Uint8Array(cols * rows);
    let inZoneCount = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const centre = { x: minX + (c + 0.5) * cellM, y: minY + (r + 0.5) * cellM };
            if (insideRing(centre, ring)) {
                inZone[r * cols + c] = 1;
                inZoneCount++;
            }
        }
    }
    // A zone thinner than a cell still counts as one cell, the one under its origin.
    if (inZoneCount === 0) {
        const c = Math.min(cols - 1, Math.max(0, Math.floor(-minX / cellM)));
        const r = Math.min(rows - 1, Math.max(0, Math.floor(-minY / cellM)));
        inZone[r * cols + c] = 1;
        inZoneCount = 1;
    }
    return { proj, minX, minY, cellM, cols, rows, inZone, inZoneCount };
}

/** Clears `open` on every cell whose centre is within the circle; answers how many were set. */
function cover(g: Grid, open: Uint8Array, circle: Circle): number {
    const { x, y } = g.proj.toXY(circle.center);
    const r0 = Math.max(0, Math.floor((y - circle.radiusM - g.minY) / g.cellM));
    const r1 = Math.min(g.rows - 1, Math.floor((y + circle.radiusM - g.minY) / g.cellM));
    const c0 = Math.max(0, Math.floor((x - circle.radiusM - g.minX) / g.cellM));
    const c1 = Math.min(g.cols - 1, Math.floor((x + circle.radiusM - g.minX) / g.cellM));
    const r2 = circle.radiusM * circle.radiusM;
    let cleared = 0;
    for (let r = r0; r <= r1; r++) {
        const dy = g.minY + (r + 0.5) * g.cellM - y;
        for (let c = c0; c <= c1; c++) {
            const i = r * g.cols + c;
            const dx = g.minX + (c + 0.5) * g.cellM - x;
            if (open[i] && dx * dx + dy * dy <= r2) {
                open[i] = 0;
                cleared++;
            }
        }
    }
    return cleared;
}

/** Share (0..1) of the zone's cells within at least one circle. */
export function coverage(boundary: LatLng[], circles: Circle[]): number {
    if (circles.length === 0) return 0;
    const g = grid(boundary, Math.min(...circles.map((c) => c.radiusM)));
    const open = g.inZone.slice();
    const covered = circles.reduce((n, circle) => n + cover(g, open, circle), 0);
    return covered / g.inZoneCount;
}

export type SuggestOptions = { targetCoverage: number; radiusM: number };

export type Suggestion = {
    sites: LatLng[];
    /** Deployed circles alone, and with the sites. */
    coverage: number;
    projectedCoverage: number;
};

const MAX_SITES = 60;

/**
 * Greedy set cover: after the deployed circles, repeatedly add the site (a cell centre on every
 * second row and column) that covers the most uncovered cells, until `targetCoverage` is met, the
 * best site adds under 0.5% of the zone, or there are 60 sites.
 */
export function suggestSites(
    boundary: LatLng[],
    deployed: Circle[],
    { targetCoverage, radiusM }: SuggestOptions,
): Suggestion {
    const g = grid(boundary, radiusM);
    const { cols, rows, cellM } = g;
    const open = g.inZone.slice();
    let covered = deployed.reduce((n, circle) => n + cover(g, open, circle), 0);
    const before = covered / g.inZoneCount;

    const reach = radiusM / cellM;
    const k = Math.min(rows, Math.floor(reach));
    const span = Array.from({ length: k + 1 }, (_, dr) =>
        Math.floor(Math.sqrt(Math.max(0, reach * reach - dr * dr)) + 1e-9),
    );
    // Per row, how many open cells lie left of each column: a disk's gain is one lookup per row.
    const stride = cols + 1;
    const prefix = new Int32Array(rows * stride);
    const rebuild = (r: number) => {
        let sum = 0;
        for (let c = 0; c < cols; c++) {
            sum += open[r * cols + c]!;
            prefix[r * stride + c + 1] = sum;
        }
    };
    for (let r = 0; r < rows; r++) rebuild(r);
    const gain = (r: number, c: number) => {
        let total = 0;
        for (let dr = -k; dr <= k; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            const w = span[Math.abs(dr)]!;
            const lo = Math.max(0, c - w);
            const hi = Math.min(cols - 1, c + w);
            total += prefix[rr * stride + hi + 1]! - prefix[rr * stride + lo]!;
        }
        return total;
    };

    const inZone = (i: number) => g.inZone[i] === 1;
    let candidates: number[] = [];
    for (let i = 0; i < cols * rows; i++) {
        if (inZone(i) && Math.floor(i / cols) % 2 === 0 && (i % cols) % 2 === 0) candidates.push(i);
    }
    if (candidates.length === 0) candidates = [...g.inZone.keys()].filter(inZone);

    const minGain = Math.max(1, 0.005 * g.inZoneCount);
    const sites: LatLng[] = [];
    while (sites.length < MAX_SITES && covered / g.inZoneCount < targetCoverage) {
        let best = -1;
        let bestGain = 0;
        for (const i of candidates) {
            const n = gain(Math.floor(i / cols), i % cols);
            if (n > bestGain) {
                best = i;
                bestGain = n;
            }
        }
        if (best < 0 || bestGain < minGain) break;
        const r = Math.floor(best / cols);
        const site = g.proj.toLatLng({
            x: g.minX + ((best % cols) + 0.5) * cellM,
            y: g.minY + (r + 0.5) * cellM,
        });
        covered += cover(g, open, { center: site, radiusM });
        for (let rr = Math.max(0, r - k - 1); rr <= Math.min(rows - 1, r + k + 1); rr++) {
            rebuild(rr);
        }
        sites.push(site);
    }
    return { sites, coverage: before, projectedCoverage: covered / g.inZoneCount };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** 8-way compass point from `from` to `to`; `N` when they coincide. */
export function compassPoint(from: LatLng, to: LatLng): (typeof COMPASS)[number] {
    const { x, y } = projection(from).toXY(to);
    const bearing = (Math.atan2(x, y) / RAD + 360) % 360;
    return COMPASS[Math.round(bearing / 45) % 8]!;
}

/** `NE-1` style: compass point from the zone's centre plus the lowest number not in `taken`. */
export function siteName(center: LatLng, site: LatLng, taken: Set<string>): string {
    const point = compassPoint(center, site);
    let n = 1;
    while (taken.has(`${point}-${n}`)) n++;
    const name = `${point}-${n}`;
    taken.add(name);
    return name;
}
