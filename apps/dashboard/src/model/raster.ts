import type { DroneDetections, LatLng, MappingRun, RiskZone } from '@ember/contracts';
import { metersPerDegLon, pointInPolygon } from './geo';
import type { Grid, LatLon } from './types';

const M_PER_DEG = 111_320;

export const MAPPED_BEFORE = 1;
export const MAPPED_NOW = 2;
export const AT_RISK = 2;
export const ON_FIRE = 3;

/**
 * Marks every zone cell a mapping run covered: `MAPPED_NOW` for runs of `currentRunId`, else
 * `MAPPED_BEFORE`. A run's grid is square around its edge server, `cols = ceil(2R / cell)` a side,
 * cell 0 at the south-west corner (`MappingMission` in the contracts).
 */
export function mappedCells(
    grid: Grid,
    runs: MappingRun[],
    currentRunId: string | null,
): Uint8Array {
    const out = new Uint8Array(grid.rows * grid.cols);
    const ordered = [...runs].sort(
        (a, b) => Number(a.runId === currentRunId) - Number(b.runId === currentRunId),
    );
    for (const run of ordered) {
        const value = run.runId === currentRunId ? MAPPED_NOW : MAPPED_BEFORE;
        const size = run.cellSizeM;
        const n = Math.ceil((2 * run.connectivityRadiusM) / size);
        const half = (n * size) / 2;
        const kLon = metersPerDegLon(run.edgeServer.lat);
        const dLat = size / M_PER_DEG / grid.dlat;
        const dLon = size / kLon / grid.dlon;
        for (const index of run.cells) {
            const row = Math.floor(index / n);
            const col = index % n;
            const south = run.edgeServer.lat + (row * size - half) / M_PER_DEG;
            const west = run.edgeServer.lng + (col * size - half) / kLon;
            const r0 = Math.floor((south - grid.south) / grid.dlat);
            const c0 = Math.floor((west - grid.west) / grid.dlon);
            const r1 = Math.max(r0, Math.ceil((south - grid.south) / grid.dlat + dLat) - 1);
            const c1 = Math.max(c0, Math.ceil((west - grid.west) / grid.dlon + dLon) - 1);
            for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r++) {
                for (let c = Math.max(0, c0); c <= Math.min(grid.cols - 1, c1); c++) {
                    const i = r * grid.cols + c;
                    if (grid.inZone[i] && out[i]! < value) out[i] = value;
                }
            }
        }
    }
    return out;
}

function fillPolygon(grid: Grid, ring: LatLng[], value: number, out: Uint8Array): void {
    if (ring.length === 0) return;
    const points: LatLon[] = ring.map((p) => [p.lat, p.lng]);
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const r0 = Math.max(0, Math.floor((Math.min(...lats) - grid.south) / grid.dlat));
    const r1 = Math.min(grid.rows - 1, Math.floor((Math.max(...lats) - grid.south) / grid.dlat));
    const c0 = Math.max(0, Math.floor((Math.min(...lons) - grid.west) / grid.dlon));
    const c1 = Math.min(grid.cols - 1, Math.floor((Math.max(...lons) - grid.west) / grid.dlon));
    let filled = false;
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const at: LatLon = [
                grid.south + (r + 0.5) * grid.dlat,
                grid.west + (c + 0.5) * grid.dlon,
            ];
            if (points.length >= 3 && !pointInPolygon(at, points)) continue;
            const i = r * grid.cols + c;
            if (out[i]! < value) out[i] = value;
            filled = true;
        }
    }
    // Smaller than a cell: mark the cell under its middle.
    if (!filled) {
        const mid: LatLon = [
            (Math.min(...lats) + Math.max(...lats)) / 2,
            (Math.min(...lons) + Math.max(...lons)) / 2,
        ];
        const r = Math.floor((mid[0] - grid.south) / grid.dlat);
        const c = Math.floor((mid[1] - grid.west) / grid.dlon);
        if (r >= 0 && r < grid.rows && c >= 0 && c < grid.cols) {
            const i = r * grid.cols + c;
            if (out[i]! < value) out[i] = value;
        }
    }
}

/** `AT_RISK` and `ON_FIRE` cells from the api's risk zones and the drones' latest frames. */
export function riskCells(
    grid: Grid,
    zones: RiskZone[],
    frames: readonly DroneDetections[],
): Uint8Array {
    const out = new Uint8Array(grid.rows * grid.cols);
    for (const z of zones)
        fillPolygon(grid, z.polygon, z.risk === 'on_fire' ? ON_FIRE : AT_RISK, out);
    for (const f of frames)
        for (const d of f.detections)
            fillPolygon(grid, d.ground, d.risk === 'on_fire' ? ON_FIRE : AT_RISK, out);
    return out;
}

/** Share (0..1) of the zone's cells that some run has mapped. */
export function mappedShare(grid: Grid, mapped: Uint8Array): number {
    if (grid.inZoneCount === 0) return 0;
    let n = 0;
    for (let i = 0; i < mapped.length; i++) if (mapped[i]) n += 1;
    return n / grid.inZoneCount;
}
