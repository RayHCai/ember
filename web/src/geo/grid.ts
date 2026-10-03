import type { EdgeServer, GridInfo, LatLon } from "../types/events";

// Client-side mirror of the server's grid math (server/app/geo), used for live
// feedback while the operator edits: area while drawing, coverage while dragging.

const M_PER_DEG_LAT = 111_320;

export function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Equirectangular projection to metres around a reference point. */
export function projector(ref: LatLon) {
  const kx = metersPerDegLon(ref[0]);
  return (p: LatLon): [number, number] => [(p[1] - ref[1]) * kx, (p[0] - ref[0]) * M_PER_DEG_LAT];
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
  const ref: LatLon = [
    polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
    polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
  ];
  const xy = polygon.map(projector(ref));
  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]!;
    const [x2, y2] = xy[(i + 1) % xy.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2 / 1e6;
}

export function cellCenter(grid: GridInfo, index: number): LatLon {
  const row = Math.floor(index / grid.cols);
  const col = index % grid.cols;
  return [grid.south + (row + 0.5) * grid.dlat, grid.west + (col + 0.5) * grid.dlon];
}

export function zoneCellIndexes(grid: GridInfo): number[] {
  const cells: number[] = [];
  for (let i = 0; i < grid.in_zone.length; i++) if (grid.in_zone.charCodeAt(i) === 49) cells.push(i);
  return cells;
}

/** Same layout as the server's ZoneGrid.from_polygon (mock data and tests). */
export function makeGrid(polygon: LatLon[], cellM = 100): GridInfo {
  const lats = polygon.map((p) => p[0]);
  const lons = polygon.map((p) => p[1]);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const dlat = cellM / M_PER_DEG_LAT;
  const dlon = cellM / metersPerDegLon((south + north) / 2);
  const rows = Math.floor((north - south) / dlat) + 1;
  const cols = Math.floor((east - west) / dlon) + 1;
  const grid: GridInfo = { south, west, north: south + rows * dlat, east: west + cols * dlon, dlat, dlon, rows, cols, cell_m: cellM, in_zone: "" };
  let mask = "";
  for (let i = 0; i < rows * cols; i++) mask += pointInPolygon(cellCenter(grid, i), polygon) ? "1" : "0";
  grid.in_zone = mask;
  return grid;
}

export interface CoverageResult {
  pct: number;
  /** One entry per grid cell: 1 if an in-zone cell is covered. */
  covered: Uint8Array;
}

export function computeCoverage(grid: GridInfo, servers: Pick<EdgeServer, "lat" | "lon" | "radius_m">[]): CoverageResult {
  const cells = zoneCellIndexes(grid);
  const covered = new Uint8Array(grid.rows * grid.cols);
  if (cells.length === 0) return { pct: 0, covered };
  const project = projector([(grid.south + grid.north) / 2, (grid.west + grid.east) / 2]);
  const sxy = servers.map((s) => ({ xy: project([s.lat, s.lon]), r2: s.radius_m * s.radius_m }));
  let count = 0;
  for (const i of cells) {
    const [x, y] = project(cellCenter(grid, i));
    for (const s of sxy) {
      const dx = x - s.xy[0];
      const dy = y - s.xy[1];
      if (dx * dx + dy * dy <= s.r2) {
        covered[i] = 1;
        count += 1;
        break;
      }
    }
  }
  return { pct: Math.round((1000 * count) / cells.length) / 10, covered };
}
