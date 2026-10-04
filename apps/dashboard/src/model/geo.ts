import type { Grid, LatLon } from './types';

const M_PER_DEG_LAT = 111_320;

export function metersPerDegLon(lat: number): number {
    return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Equirectangular projection to metres around a reference point. */
export function projector(ref: LatLon) {
    const kx = metersPerDegLon(ref[0]);
    return (p: LatLon): [number, number] => [(p[1] - ref[1]) * kx, (p[0] - ref[0]) * M_PER_DEG_LAT];
}

export function offset([lat, lon]: LatLon, northM: number, eastM: number): LatLon {
    return [lat + northM / M_PER_DEG_LAT, lon + eastM / metersPerDegLon(lat)];
}

export function distanceM(a: LatLon, b: LatLon): number {
    const [x, y] = projector(a)(b);
    return Math.hypot(x, y);
}

/** Compass bearing from a to b in degrees. */
export function bearingDeg(a: LatLon, b: LatLon): number {
    const [x, y] = projector(a)(b);
    return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

export function centroid(points: LatLon[]): LatLon {
    const n = points.length || 1;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}

export function pointInPolygon([lat, lon]: LatLon, polygon: LatLon[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [latI, lonI] = polygon[i]!;
        const [latJ, lonJ] = polygon[j]!;
        if (latI > lat !== latJ > lat) {
            const crossLon = lonI + ((lat - latI) * (lonJ - lonI)) / (latJ - latI);
            if (lon < crossLon) inside = !inside;
        }
    }
    return inside;
}

export function polygonAreaKm2(polygon: LatLon[]): number {
    if (polygon.length < 3) return 0;
    const xy = polygon.map(projector(centroid(polygon)));
    let area = 0;
    for (let i = 0; i < xy.length; i++) {
        const [x1, y1] = xy[i]!;
        const [x2, y2] = xy[(i + 1) % xy.length]!;
        area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2 / 1e6;
}

export function cellCenter(grid: Grid, index: number): LatLon {
    const row = Math.floor(index / grid.cols);
    const col = index % grid.cols;
    return [grid.south + (row + 0.5) * grid.dlat, grid.west + (col + 0.5) * grid.dlon];
}

export function cellAt(grid: Grid, [lat, lon]: LatLon): number | null {
    const row = Math.floor((lat - grid.south) / grid.dlat);
    const col = Math.floor((lon - grid.west) / grid.dlon);
    if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return null;
    return row * grid.cols + col;
}

export function makeGrid(polygon: LatLon[], cellM = 100): Grid {
    const lats = polygon.map((p) => p[0]);
    const lons = polygon.map((p) => p[1]);
    const south = Math.min(...lats);
    const west = Math.min(...lons);
    const dlat = cellM / M_PER_DEG_LAT;
    const dlon = cellM / metersPerDegLon((south + Math.max(...lats)) / 2);
    const rows = Math.floor((Math.max(...lats) - south) / dlat) + 1;
    const cols = Math.floor((Math.max(...lons) - west) / dlon) + 1;
    const grid: Grid = {
        south,
        west,
        north: south + rows * dlat,
        east: west + cols * dlon,
        dlat,
        dlon,
        rows,
        cols,
        cellM,
        inZone: new Uint8Array(rows * cols),
        inZoneCount: 0,
    };
    for (let i = 0; i < rows * cols; i++) {
        if (pointInPolygon(cellCenter(grid, i), polygon)) {
            grid.inZone[i] = 1;
            grid.inZoneCount += 1;
        }
    }
    return grid;
}

export interface Coverage {
    pct: number;
    /** Per cell: 1 when an in-zone cell is within some server's radius. */
    covered: Uint8Array;
}

export function computeCoverage(
    grid: Grid,
    servers: { lat: number; lon: number; radiusM: number }[],
): Coverage {
    const covered = new Uint8Array(grid.rows * grid.cols);
    if (grid.inZoneCount === 0) return { pct: 0, covered };
    const project = projector([(grid.south + grid.north) / 2, (grid.west + grid.east) / 2]);
    const sxy = servers.map((s) => ({ xy: project([s.lat, s.lon]), r2: s.radiusM * s.radiusM }));
    let count = 0;
    for (let i = 0; i < grid.inZone.length; i++) {
        if (!grid.inZone[i]) continue;
        const [x, y] = project(cellCenter(grid, i));
        for (const s of sxy) {
            if ((x - s.xy[0]) ** 2 + (y - s.xy[1]) ** 2 <= s.r2) {
                covered[i] = 1;
                count += 1;
                break;
            }
        }
    }
    return { pct: Math.round((1000 * count) / grid.inZoneCount) / 10, covered };
}

/** A closed ring of points around a centre, for circles on the map. */
export function circle(center: LatLon, radiusM: number, segments = 72): LatLon[] {
    return Array.from({ length: segments + 1 }, (_, i) => {
        const a = (i / segments) * Math.PI * 2;
        return offset(center, Math.sin(a) * radiusM, Math.cos(a) * radiusM);
    });
}

function signedArea(ring: LatLon[]): number {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const [y1, x1] = ring[i]!;
        const [y2, x2] = ring[(i + 1) % ring.length]!;
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

/** `n` points spaced evenly along a closed ring's perimeter. */
export function resample(ring: LatLon[], n: number): LatLon[] {
    const project = projector(centroid(ring));
    const xy = ring.map(project);
    const cum = [0];
    for (let i = 1; i <= ring.length; i++) {
        const [x0, y0] = xy[i - 1]!;
        const [x1, y1] = xy[i % ring.length]!;
        cum.push(cum[i - 1]! + Math.hypot(x1 - x0, y1 - y0));
    }
    const total = cum[cum.length - 1]! || 1;
    const out: LatLon[] = [];
    let seg = 1;
    for (let k = 0; k < n; k++) {
        const d = (k / n) * total;
        while (seg < cum.length - 1 && cum[seg]! < d) seg++;
        const a = ring[seg - 1]!;
        const b = ring[seg % ring.length]!;
        const t = (d - cum[seg - 1]!) / (cum[seg]! - cum[seg - 1]! || 1);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
}

/**
 * Two rings resampled to the same length, wound the same way and with the second rotated to start
 * nearest the first's start, so one can morph into the other without twisting.
 */
export function morphPair(from: LatLon[], to: LatLon[], n = 96): [LatLon[], LatLon[]] {
    const a = resample(from, n);
    let b = resample(to, n);
    if (Math.sign(signedArea(from)) !== Math.sign(signedArea(to))) b = b.reverse();
    let best = 0;
    for (let i = 1; i < n; i++) if (distanceM(a[0]!, b[i]!) < distanceM(a[0]!, b[best]!)) best = i;
    return [a, [...b.slice(best), ...b.slice(0, best)]];
}

/**
 * The path without points closer than `minM` to the one before. Clamped polylines draw streaks
 * across the map when a segment has no length.
 */
export function distinct(path: LatLon[], minM = 0.5): LatLon[] {
    const out: LatLon[] = [];
    for (const p of path)
        if (!out.length || distanceM(out[out.length - 1]!, p) >= minM) out.push(p);
    return out;
}

/** Which anchors to label, in order, so no two labels sit closer than `minM`. */
export function spaced(anchors: LatLon[], minM: number): boolean[] {
    const kept: LatLon[] = [];
    return anchors.map((a) => {
        if (kept.some((k) => distanceM(k, a) < minM)) return false;
        kept.push(a);
        return true;
    });
}
