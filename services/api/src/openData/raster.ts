import type { Point } from './geo.js';

/** Square cells in local metres; cell (i, j) spans x from minX + i * cell, y from minY + j * cell. */
export type Grid = { minX: number; minY: number; cell: number; cols: number; rows: number };

const MAX_CELLS_PER_SIDE = 250;
const MIN_CELL_M = 10;

/** A grid centred on the local origin that covers `widthM` by `heightM`. */
export function makeGrid(widthM: number, heightM: number): Grid {
    const cell = Math.max(MIN_CELL_M, Math.max(widthM, heightM) / MAX_CELLS_PER_SIDE);
    const cols = Math.min(MAX_CELLS_PER_SIDE, Math.max(1, Math.ceil(widthM / cell)));
    const rows = Math.min(MAX_CELLS_PER_SIDE, Math.max(1, Math.ceil(heightM / cell)));
    return { minX: -(cols * cell) / 2, minY: -(rows * cell) / 2, cell, cols, rows };
}

export class Mask {
    readonly cols: number;
    readonly rows: number;
    readonly data: Uint8Array;

    constructor(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
        this.data = new Uint8Array(cols * rows);
    }

    has(i: number, j: number): boolean {
        return (
            i >= 0 && j >= 0 && i < this.cols && j < this.rows && this.data[j * this.cols + i] === 1
        );
    }

    count(): number {
        let total = 0;
        for (const value of this.data) total += value;
        return total;
    }

    indices(): number[] {
        const found: number[] = [];
        this.data.forEach((value, index) => {
            if (value === 1) found.push(index);
        });
        return found;
    }
}

/** Calls `visit` with the index of every cell whose centre lies inside the rings (even-odd). */
export function fillRings(
    grid: Grid,
    rings: readonly (readonly Point[])[],
    visit: (cell: number) => void,
): void {
    const crossings: number[][] = Array.from({ length: grid.rows }, () => []);
    for (const ring of rings) {
        for (let k = 0; k < ring.length; k++) {
            const a = ring[k];
            const b = ring[(k + 1) % ring.length];
            if (!a || !b || a.y === b.y) continue;
            const [low, high]: [Point, Point] = a.y < b.y ? [a, b] : [b, a];
            // Half-open in y so a vertex shared by two edges is counted once.
            const first = Math.max(0, Math.ceil((low.y - grid.minY) / grid.cell - 0.5));
            const last = Math.min(
                grid.rows - 1,
                Math.ceil((high.y - grid.minY) / grid.cell - 0.5) - 1,
            );
            for (let j = first; j <= last; j++) {
                const y = grid.minY + (j + 0.5) * grid.cell;
                crossings[j]?.push(low.x + ((y - low.y) * (high.x - low.x)) / (high.y - low.y));
            }
        }
    }
    crossings.forEach((xs, j) => {
        const sorted = xs.toSorted((p, q) => p - q);
        for (let k = 0; k + 1 < sorted.length; k += 2) {
            const from = Math.max(0, Math.ceil(((sorted[k] ?? 0) - grid.minX) / grid.cell - 0.5));
            const to = Math.min(
                grid.cols - 1,
                Math.ceil(((sorted[k + 1] ?? 0) - grid.minX) / grid.cell - 0.5) - 1,
            );
            for (let i = from; i <= to; i++) visit(j * grid.cols + i);
        }
    });
}

const FOUR: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

/** Cells 4-connected to a seed through `passable` cells. */
export function reach(passable: Mask, seeds: Iterable<number>): Mask {
    const { cols } = passable;
    const out = new Mask(cols, passable.rows);
    const queue = new Int32Array(passable.data.length);
    let head = 0;
    let tail = 0;
    for (const seed of seeds) {
        if (passable.data[seed] !== 1 || out.data[seed] === 1) continue;
        out.data[seed] = 1;
        queue[tail++] = seed;
    }
    while (head < tail) {
        const at = queue[head++] ?? 0;
        const i = at % cols;
        const j = (at - i) / cols;
        for (const [di, dj] of FOUR) {
            const ni = i + di;
            const nj = j + dj;
            if (!passable.has(ni, nj)) continue;
            const next = nj * cols + ni;
            if (out.data[next] === 1) continue;
            out.data[next] = 1;
            queue[tail++] = next;
        }
    }
    return out;
}

function invert(mask: Mask): Mask {
    const out = new Mask(mask.cols, mask.rows);
    mask.data.forEach((value, index) => {
        out.data[index] = value === 1 ? 0 : 1;
    });
    return out;
}

/** One dilation then one erosion (3 by 3), which bridges gaps of up to two cells. */
export function close(mask: Mask): Mask {
    const { cols, rows } = mask;
    const grown = new Mask(cols, rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            let hit = false;
            for (let dj = -1; dj <= 1 && !hit; dj++) {
                for (let di = -1; di <= 1 && !hit; di++) hit = mask.has(i + di, j + dj);
            }
            if (hit) grown.data[j * cols + i] = 1;
        }
    }
    const closed = new Mask(cols, rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            let keep = grown.has(i, j);
            for (let dj = -1; dj <= 1 && keep; dj++) {
                for (let di = -1; di <= 1 && keep; di++) {
                    // Beyond the grid counts as selected so a forest running off the edge keeps its edge.
                    const outside = i + di < 0 || j + dj < 0 || i + di >= cols || j + dj >= rows;
                    keep = outside || grown.has(i + di, j + dj);
                }
            }
            if (keep) closed.data[j * cols + i] = 1;
        }
    }
    return closed;
}

/** Selects every unselected cell that cannot reach the grid border through unselected cells. */
export function fillHoles(mask: Mask): Mask {
    const { cols, rows } = mask;
    const empty = invert(mask);
    const border: number[] = [];
    for (let i = 0; i < cols; i++) border.push(i, (rows - 1) * cols + i);
    for (let j = 0; j < rows; j++) border.push(j * cols, j * cols + cols - 1);
    const outside = reach(empty, border);
    const filled = new Mask(cols, rows);
    mask.data.forEach((value, index) => {
        filled.data[index] = value === 1 || outside.data[index] !== 1 ? 1 : 0;
    });
    return filled;
}

export function largestComponent(mask: Mask): Mask {
    const { cols } = mask;
    const label = new Int32Array(mask.data.length);
    const queue = new Int32Array(mask.data.length);
    let labels = 0;
    let best = 0;
    let bestSize = 0;
    for (let start = 0; start < mask.data.length; start++) {
        if (mask.data[start] !== 1 || label[start] !== 0) continue;
        labels++;
        let head = 0;
        let tail = 0;
        label[start] = labels;
        queue[tail++] = start;
        while (head < tail) {
            const at = queue[head++] ?? 0;
            const i = at % cols;
            const j = (at - i) / cols;
            for (const [di, dj] of FOUR) {
                if (!mask.has(i + di, j + dj)) continue;
                const next = (j + dj) * cols + i + di;
                if (label[next] !== 0) continue;
                label[next] = labels;
                queue[tail++] = next;
            }
        }
        if (tail > bestSize) {
            best = labels;
            bestSize = tail;
        }
    }
    const out = new Mask(cols, mask.rows);
    label.forEach((value, index) => {
        out.data[index] = value === best ? 1 : 0;
    });
    return out;
}

type Direction = 0 | 1 | 2 | 3;
const STEP = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
] as const;
const LEFT: Record<Direction, Direction> = { 0: 1, 1: 2, 2: 3, 3: 0 };
const RIGHT: Record<Direction, Direction> = { 0: 3, 1: 0, 2: 1, 3: 2 };

/** Whether the boundary edge leaving lattice vertex (x, y) toward `dir` keeps the mask on its left. */
function edgeOpen(mask: Mask, x: number, y: number, dir: Direction): boolean {
    switch (dir) {
        case 0:
            return mask.has(x, y) && !mask.has(x, y - 1);
        case 1:
            return mask.has(x - 1, y) && !mask.has(x, y);
        case 2:
            return mask.has(x - 1, y - 1) && !mask.has(x - 1, y);
        default:
            return mask.has(x, y - 1) && !mask.has(x - 1, y - 1);
    }
}

/**
 * The outer boundary of a hole-free, 4-connected mask as counter-clockwise lattice corners
 * (vertex (x, y) is the south-west corner of cell (x, y)). Empty when the mask is empty.
 */
export function traceOutline(mask: Mask): { x: number; y: number }[] {
    const first = mask.data.indexOf(1);
    if (first < 0) return [];
    const startX = first % mask.cols;
    const startY = (first - startX) / mask.cols;

    const corners = [{ x: startX, y: startY }];
    let x = startX;
    let y = startY;
    let dir: Direction = 0;
    const limit = 4 * (mask.cols + 1) * (mask.rows + 1);
    for (let steps = 0; steps < limit; steps++) {
        const [dx, dy] = STEP[dir];
        x += dx;
        y += dy;
        const turns: Direction[] = [LEFT[dir], dir, RIGHT[dir]];
        const next = turns.find((turn) => edgeOpen(mask, x, y, turn));
        if (next === undefined) break;
        if (x === startX && y === startY && next === 0) break;
        if (next !== dir) corners.push({ x, y });
        dir = next;
    }
    return corners;
}
