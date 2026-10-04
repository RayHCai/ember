import type { Building, Road } from './assets';

/** An oriented rectangle in the world frame; `angleRad` is the direction of its `lengthM` side. */
export type Rect = { cx: number; cy: number; lengthM: number; widthM: number; angleRad: number };

/** What fitting needs to know of a building model: the footprint and wall height it was made for. */
export type KitModel = {
    kind: 'house' | 'block' | 'ruin';
    lengthM: number;
    widthM: number;
    wallHeightM: number;
};

/**
 * One model standing in for a building or a part of it. The model's X (its `lengthM`) runs along
 * `rect.angleRad` and its front (+Z) faces `rect.angleRad - 90°`.
 */
export type Placement = { model: number; rect: Rect; heightScale: number };

/** Each model past the first that a footprint is split into costs this much misfit. */
const SPLIT_COST = 0.22;
const HEIGHT_SCALE: [number, number] = [0.8, 1.35];
/** Footprints filling less of their bounding rectangle than this are covered piece by piece. */
const MIN_FILL = 0.8;
const ROAD_CELL_M = 80;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const hash = (i: number, k: number): number => {
    const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return s - Math.floor(s);
};

function area(points: [number, number][]): number {
    let twice = 0;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]!;
        const [bx, by] = points[(i + 1) % points.length]!;
        twice += ax * by - bx * ay;
    }
    return Math.abs(twice) / 2;
}

/** Smallest rectangle around a footprint, and how much of it the footprint fills. */
export function minAreaRect(points: [number, number][]): Rect & { fill: number } {
    let best: (Rect & { area: number }) | null = null;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]!;
        const [bx, by] = points[(i + 1) % points.length]!;
        const a = Math.atan2(by - ay, bx - ax);
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        let s0 = Infinity;
        let s1 = -Infinity;
        let t0 = Infinity;
        let t1 = -Infinity;
        for (const [x, y] of points) {
            const s = x * ux + y * uy;
            const t = -x * uy + y * ux;
            s0 = Math.min(s0, s);
            s1 = Math.max(s1, s);
            t0 = Math.min(t0, t);
            t1 = Math.max(t1, t);
        }
        const boxArea = (s1 - s0) * (t1 - t0);
        if (best && boxArea >= best.area) continue;
        const sc = (s0 + s1) / 2;
        const tc = (t0 + t1) / 2;
        const long = s1 - s0 >= t1 - t0;
        best = {
            cx: sc * ux - tc * uy,
            cy: sc * uy + tc * ux,
            lengthM: long ? s1 - s0 : t1 - t0,
            widthM: long ? t1 - t0 : s1 - s0,
            angleRad: long ? a : a + Math.PI / 2,
            area: boxArea,
        };
    }
    if (!best || best.area <= 0)
        return { cx: 0, cy: 0, lengthM: 0, widthM: 0, angleRad: 0, fill: 0 };
    const { area: boxArea, ...rect } = best;
    return { ...rect, fill: area(points) / boxArea };
}

function inside(points: [number, number][], x: number, y: number): boolean {
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]!;
        const [xj, yj] = points[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
}

/** Largest all-free rectangle of a grid (rows of `nu` cells), as cell indices and counts. */
function largestFree(
    free: Uint8Array,
    nu: number,
    nv: number,
): { i: number; j: number; w: number; h: number } | null {
    const heights = new Int32Array(nu + 1);
    let best: { i: number; j: number; w: number; h: number } | null = null;
    for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) heights[i] = free[j * nu + i] ? heights[i]! + 1 : 0;
        const stack: number[] = [];
        for (let i = 0; i <= nu; i++) {
            const h = i < nu ? heights[i]! : 0;
            while (stack.length && heights[stack[stack.length - 1]!]! >= h) {
                const top = heights[stack.pop()!]!;
                const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
                if (top > 0 && (!best || top * (i - left) > best.w * best.h))
                    best = { i: left, j: j - top + 1, w: i - left, h: top };
            }
            stack.push(i);
        }
    }
    return best;
}

/**
 * An irregular footprint as a few rectangles in the frame of its bounding rectangle: the largest
 * rectangle that fits inside it, then the largest in what is left, until little is left.
 */
export function decompose(points: [number, number][], frame: Rect, most = 12): Rect[] {
    const { cx, cy, lengthM: L, widthM: W, angleRad } = frame;
    const ux = Math.cos(angleRad);
    const uy = Math.sin(angleRad);
    const cell = clamp(Math.min(L, W) / 14, 1, 4);
    const nu = Math.max(1, Math.round(L / cell));
    const nv = Math.max(1, Math.round(W / cell));
    const du = L / nu;
    const dv = W / nv;
    const world = (s: number, t: number): [number, number] => [
        cx + ux * (s - L / 2) - uy * (t - W / 2),
        cy + uy * (s - L / 2) + ux * (t - W / 2),
    ];
    const free = new Uint8Array(nu * nv);
    let total = 0;
    for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
            const [x, y] = world((i + 0.5) * du, (j + 0.5) * dv);
            if (inside(points, x, y)) {
                free[j * nu + i] = 1;
                total++;
            }
        }
    const out: Rect[] = [];
    while (out.length < most) {
        const r = largestFree(free, nu, nv);
        if (!r || r.w * r.h < Math.max(2, 0.04 * total)) break;
        if (out.length && (r.w * du < 3 || r.h * dv < 3)) break;
        for (let j = r.j; j < r.j + r.h; j++) free.fill(0, j * nu + r.i, j * nu + r.i + r.w);
        const [x, y] = world((r.i + r.w / 2) * du, (r.j + r.h / 2) * dv);
        out.push({ cx: x, cy: y, lengthM: r.w * du, widthM: r.h * dv, angleRad });
    }
    return out.length ? out : [frame];
}

/** Finds, for a point, the offset to the nearest road within a block or so, or null. */
export function roadFinder(roads: Road[]): (x: number, y: number) => [number, number] | null {
    const cells = new Map<string, number[]>();
    const segments: number[] = [];
    for (const road of roads)
        for (let k = 0; k + 1 < road.points.length; k++) {
            const [ax, ay] = road.points[k]!;
            const [bx, by] = road.points[k + 1]!;
            const index = segments.length / 4;
            segments.push(ax, ay, bx, by);
            const i0 = Math.floor(Math.min(ax, bx) / ROAD_CELL_M);
            const i1 = Math.floor(Math.max(ax, bx) / ROAD_CELL_M);
            const j0 = Math.floor(Math.min(ay, by) / ROAD_CELL_M);
            const j1 = Math.floor(Math.max(ay, by) / ROAD_CELL_M);
            for (let i = i0; i <= i1; i++)
                for (let j = j0; j <= j1; j++) {
                    const key = `${i}:${j}`;
                    let list = cells.get(key);
                    if (!list) cells.set(key, (list = []));
                    list.push(index);
                }
        }
    return (x, y) => {
        const ci = Math.floor(x / ROAD_CELL_M);
        const cj = Math.floor(y / ROAD_CELL_M);
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (let i = ci - 1; i <= ci + 1; i++)
            for (let j = cj - 1; j <= cj + 1; j++)
                for (const s of cells.get(`${i}:${j}`) ?? []) {
                    const ax = segments[s * 4]!;
                    const ay = segments[s * 4 + 1]!;
                    const dx = segments[s * 4 + 2]! - ax;
                    const dy = segments[s * 4 + 3]! - ay;
                    const t = clamp(
                        ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1),
                        0,
                        1,
                    );
                    const px = ax + dx * t - x;
                    const py = ay + dy * t - y;
                    const d = px * px + py * py;
                    if (d < bestD) {
                        bestD = d;
                        best = [px, py];
                    }
                }
        return best;
    };
}

/** How badly a model fits a `frontM` by `depthM` plot with walls `heightM` high (0: exactly). */
export function misfit(model: KitModel, frontM: number, depthM: number, heightM: number): number {
    const sx = Math.log(frontM / model.lengthM);
    const sz = Math.log(depthM / model.widthM);
    const sy = model.wallHeightM > 0 ? Math.log(heightM / model.wallHeightM) : 0;
    return Math.abs(sx) + Math.abs(sz) + 0.5 * Math.abs(sx - sz) + 0.9 * Math.abs(sy);
}

/** The model of `kind` that fits best; near-ties go to `salt`, so equal plots still differ. */
export function pick(
    kit: KitModel[],
    kind: KitModel['kind'],
    frontM: number,
    depthM: number,
    heightM: number,
    salt: number,
): { model: number; cost: number } {
    const costs = kit.map((m) => (m.kind === kind ? misfit(m, frontM, depthM, heightM) : Infinity));
    const best = Math.min(...costs);
    if (!Number.isFinite(best)) throw new Error(`no ${kind} models in assets/buildings`);
    const close = costs.flatMap((c, i) => (c <= best + 0.08 ? [i] : []));
    return { model: close[Math.floor(hash(salt, 5) * close.length)]!, cost: best };
}

/** The world direction a rectangle's model faces: its front is the side on the right of `angleRad`. */
const facing = (angleRad: number): [number, number] => [Math.sin(angleRad), -Math.cos(angleRad)];

/** Turns a rectangle so its front faces the road: either long side, or (`anySide`) any of the four. */
function towardsRoad(
    rect: Rect,
    toRoad: [number, number] | null,
    anySide: boolean,
    salt: number,
): Rect {
    const turns = anySide && toRoad ? [0, 1, 2, 3] : [0, 2];
    let best = turns[hash(salt, 9) < 0.5 ? 0 : 1]!;
    if (toRoad) {
        let bestDot = -Infinity;
        for (const k of turns) {
            const f = facing(rect.angleRad + (k * Math.PI) / 2);
            const dot = f[0] * toRoad[0] + f[1] * toRoad[1];
            if (dot > bestDot) {
                bestDot = dot;
                best = k;
            }
        }
    }
    const swap = best % 2 === 1;
    return {
        cx: rect.cx,
        cy: rect.cy,
        lengthM: swap ? rect.widthM : rect.lengthM,
        widthM: swap ? rect.lengthM : rect.widthM,
        angleRad: rect.angleRad + (best * Math.PI) / 2,
    };
}

/** One rectangle as a row (and for blocks, rows) of models, as few as fit without much stretching. */
function units(
    kit: KitModel[],
    kind: 'house' | 'block',
    rect: Rect,
    heightM: number,
    salt: number,
): Placement[] {
    const { lengthM: f, widthM: d, angleRad } = rect;
    const [maxN, maxM] = kind === 'house' ? [3, 1] : [8, 5];
    let best = { n: 1, m: 1, cost: Infinity };
    for (let n = 1; n <= maxN; n++)
        for (let m = 1; m <= maxM; m++) {
            if (n * m > 1 && (f / n < 5 || d / m < 5)) continue;
            const cost =
                pick(kit, kind, f / n, d / m, heightM, salt).cost + SPLIT_COST * (n * m - 1);
            if (cost < best.cost) best = { n, m, cost };
        }
    const { n, m } = best;
    const ux = Math.cos(angleRad);
    const uy = Math.sin(angleRad);
    const [fx, fy] = facing(angleRad);
    const out: Placement[] = [];
    for (let i = 0; i < n; i++)
        for (let j = 0; j < m; j++) {
            const unit = salt * 31 + i * 7 + j;
            const { model } = pick(kit, kind, f / n, d / m, heightM, unit);
            const s = ((i + 0.5) / n - 0.5) * f;
            const t = (0.5 - (j + 0.5) / m) * d;
            // Neighbours in a row stand at slightly different heights, as separate buildings do.
            const vary = n * m > 1 ? 1 + 0.07 * (hash(unit, 3) - 0.5) : 1;
            out.push({
                model,
                rect: {
                    cx: rect.cx + ux * s + fx * t,
                    cy: rect.cy + uy * s + fy * t,
                    lengthM: f / n,
                    widthM: d / m,
                    angleRad,
                },
                heightScale: clamp((heightM / kit[model]!.wallHeightM) * vary, ...HEIGHT_SCALE),
            });
        }
    return out;
}

/**
 * The `assets/` models that stand in for a building. Demo Data's gable footprints become houses
 * with their ridge along the footprint; flat roofs become town blocks, irregular outlines covered
 * rectangle by rectangle. Long or large rectangles are split into a row of models, and fronts
 * face the nearest road (`toRoad`: offset from the building to it).
 */
export function layout(
    b: Building,
    kit: KitModel[],
    toRoad: (x: number, y: number) => [number, number] | null,
): Placement[] {
    if (b.roof === 'gable' && b.gable) {
        const rect = towardsRoad(b.gable, toRoad(b.gable.cx, b.gable.cy), false, b.id);
        return units(kit, 'house', rect, b.heightM, b.id);
    }
    if (b.footprint.length < 3) return [];
    const { fill, ...bounds } = minAreaRect(b.footprint);
    if (bounds.lengthM <= 0 || bounds.widthM <= 0) return [];
    const rects = fill >= MIN_FILL ? [bounds] : decompose(b.footprint, bounds);
    return rects.flatMap((r, k) => {
        const salt = b.id * 13 + k;
        return units(kit, 'block', towardsRoad(r, toRoad(r.cx, r.cy), true, salt), b.heightM, salt);
    });
}

/** The ruin that covers a rectangle with the least distortion. */
export function ruinFor(kit: KitModel[], rect: Rect, salt: number): number {
    return pick(kit, 'ruin', rect.lengthM, rect.widthM, 0, salt).model;
}
