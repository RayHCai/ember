import type { GridInfo, Spread } from "../types/events";

export interface SpreadGrid {
  grid: GridInfo;
  /** Minutes until the fire arrives, per grid cell (Infinity where it never does). */
  arrival: Float32Array;
}

/** A lat/lon grid that holds a spread prediction's cells. */
export function spreadGrid(spread: Spread): SpreadGrid | null {
  if (spread.cells.length === 0) return null;
  const lats = spread.cells.map((c) => c[0]);
  const lons = spread.cells.map((c) => c[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const dlat = spread.cell_m / 111_320;
  const dlon = spread.cell_m / (111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
  const rows = Math.round((maxLat - minLat) / dlat) + 1;
  const cols = Math.round((maxLon - minLon) / dlon) + 1;
  const south = minLat - dlat / 2;
  const west = minLon - dlon / 2;
  const arrival = new Float32Array(rows * cols).fill(Number.POSITIVE_INFINITY);
  for (const [lat, lon, m] of spread.cells) {
    const row = Math.round((lat - minLat) / dlat);
    const col = Math.round((lon - minLon) / dlon);
    if (row >= 0 && row < rows && col >= 0 && col < cols) arrival[row * cols + col] = m;
  }
  const grid: GridInfo = {
    south,
    west,
    north: south + rows * dlat,
    east: west + cols * dlon,
    dlat,
    dlon,
    rows,
    cols,
    cell_m: spread.cell_m,
    in_zone: "",
  };
  return { grid, arrival };
}
