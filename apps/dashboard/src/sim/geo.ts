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
