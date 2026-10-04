import type { FuelType, TerrainGrid } from '@ember/contracts';

/** One horizontal strip of same-fuel cells, in grid cells. Rows count from the south. */
export type FuelRun = { row: number; col: number; len: number; fuel: FuelType };

/**
 * Collapses the fuel layer into runs so the base map draws a few hundred rects instead of one per
 * cell. Grids larger than `maxCells` per side are sampled down first.
 */
export function fuelRuns(grid: TerrainGrid, maxCells = 96): { runs: FuelRun[]; step: number } {
    const { fuel, cols, rows } = grid;
    if (!fuel) return { runs: [], step: 1 };
    const step = Math.max(1, Math.ceil(Math.max(cols, rows) / maxCells));
    const runs: FuelRun[] = [];
    for (let r = 0; r < rows; r += step) {
        let start = 0;
        let current: FuelType | undefined;
        for (let c = 0; c < cols + step; c += step) {
            const f = c < cols ? fuel[r * cols + c] : undefined;
            if (f !== current) {
                if (current !== undefined && current !== 'none') {
                    runs.push({
                        row: r,
                        col: start,
                        len: Math.min(c, cols) - start,
                        fuel: current,
                    });
                }
                start = c;
                current = f;
            }
        }
    }
    return { runs, step };
}
