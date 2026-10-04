import type { LatLng, RiskZone } from '@ember/contracts';
import { centroid, insideRing, projection, type Point } from './geo.js';

type Risk = RiskZone['risk'];

/** A stored detections frame, as much of it as merging reads. */
export type RiskFrame = {
    /** The api's frame id: detection ids are only unique within a frame. */
    id: string;
    droneId: string;
    capturedAt: Date;
    detections: {
        detectionId: string;
        risk: Risk;
        confidence: number;
        ground: LatLng[];
        center: LatLng;
    }[];
};

const CELL_M = 10;
// A footprint this large is a bad pose, not a fire; it counts as the cell under its centre.
const MAX_CELLS_PER_DETECTION = 250_000;
const STRENGTH: Record<Risk, number> = { at_risk: 1, on_fire: 2 };
const NEIGHBOURS = [-1, 0, 1].flatMap((dr) =>
    [-1, 0, 1].filter((dc) => dr !== 0 || dc !== 0).map((dc) => [dr, dc] as const),
);

type Cell = {
    row: number;
    col: number;
    risk: Risk;
    confidence: number;
    first: number;
    last: number;
    detections: Set<string>;
    drones: Set<string>;
};

type Pair = [number, number];

const key = (row: number, col: number) => `${row}:${col}`;
const toCell = (p: Point): Pair => [Math.floor(p.y / CELL_M), Math.floor(p.x / CELL_M)];
const cross = (o: Pair, a: Pair, b: Pair) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** The grid cells (row, col) whose centre lies inside `ground`, else the one under `center`. */
function rasterise(ground: Point[], center: Point): Pair[] {
    if (ground.length >= 3) {
        const [r0, c0] = toCell({
            x: Math.min(...ground.map((p) => p.x)),
            y: Math.min(...ground.map((p) => p.y)),
        });
        const [r1, c1] = toCell({
            x: Math.max(...ground.map((p) => p.x)),
            y: Math.max(...ground.map((p) => p.y)),
        });
        if ((r1 - r0 + 1) * (c1 - c0 + 1) <= MAX_CELLS_PER_DETECTION) {
            const cells: Pair[] = [];
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const mid = { x: (c + 0.5) * CELL_M, y: (r + 0.5) * CELL_M };
                    if (insideRing(mid, ground)) cells.push([r, c]);
                }
            }
            if (cells.length > 0) return cells;
        }
    }
    return [toCell(center)];
}

/** One side of the hull over sorted points, without its last point (the other side's first). */
function hullSide(sorted: Pair[]): Pair[] {
    const out: Pair[] = [];
    for (const p of sorted) {
        while (out.length >= 2 && cross(out.at(-2)!, out.at(-1)!, p) <= 0) out.pop();
        out.push(p);
    }
    return out.slice(0, -1);
}

/** Andrew's monotone chain over integer points; counter-clockwise, first point not repeated. */
function convexHull(points: Pair[]): Pair[] {
    const unique = [...new Map(points.map((p) => [key(p[0], p[1]), p])).values()].toSorted(
        (a, b) => a[0] - b[0] || a[1] - b[1],
    );
    if (unique.length <= 2) return unique;
    return [...hullSide(unique), ...hullSide(unique.toReversed())];
}

/**
 * Merges detections into risk zones: each detection's ground outline is rasterised onto a 10 m
 * grid anchored at the zone boundary's south-west corner, each cell keeps its strongest class
 * (on_fire over at_risk), and 8-connected cells of one class form a zone. On fire first, then
 * largest first.
 */
export function mergeRiskZones(boundary: LatLng[], frames: RiskFrame[]): RiskZone[] {
    const proj = projection(centroid(boundary));
    const anchor = proj.toXY({
        lat: Math.min(...boundary.map((p) => p.lat)),
        lng: Math.min(...boundary.map((p) => p.lng)),
    });
    const local = (p: LatLng): Point => {
        const { x, y } = proj.toXY(p);
        return { x: x - anchor.x, y: y - anchor.y };
    };
    const toLatLng = (col: number, row: number) =>
        proj.toLatLng({ x: anchor.x + col * CELL_M, y: anchor.y + row * CELL_M });

    const cells = new Map<string, Cell>();
    for (const frame of frames) {
        const at = frame.capturedAt.getTime();
        for (const d of frame.detections) {
            const detection = `${frame.id}:${d.detectionId}`;
            for (const [row, col] of rasterise(d.ground.map(local), local(d.center))) {
                const k = key(row, col);
                const cell = cells.get(k);
                if (!cell || STRENGTH[d.risk] > STRENGTH[cell.risk]) {
                    cells.set(k, {
                        row,
                        col,
                        risk: d.risk,
                        confidence: d.confidence,
                        first: at,
                        last: at,
                        detections: new Set([detection]),
                        drones: new Set([frame.droneId]),
                    });
                } else if (d.risk === cell.risk) {
                    cell.confidence = Math.max(cell.confidence, d.confidence);
                    cell.first = Math.min(cell.first, at);
                    cell.last = Math.max(cell.last, at);
                    cell.detections.add(detection);
                    cell.drones.add(frame.droneId);
                }
            }
        }
    }

    const zones: RiskZone[] = [];
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const risk of ['on_fire', 'at_risk'] as const) {
        for (const [start, startCell] of cells) {
            if (startCell.risk !== risk || seen.has(start)) continue;
            seen.add(start);
            const component: Cell[] = [];
            const queue = [startCell];
            for (let cell = queue.pop(); cell; cell = queue.pop()) {
                component.push(cell);
                for (const [dr, dc] of NEIGHBOURS) {
                    const k = key(cell.row + dr, cell.col + dc);
                    const next = cells.get(k);
                    if (next && next.risk === risk && !seen.has(k)) {
                        seen.add(k);
                        queue.push(next);
                    }
                }
            }
            zones.push(riskZone(risk, component, toLatLng, ids));
        }
    }
    return zones.toSorted(
        (a, b) =>
            STRENGTH[b.risk] - STRENGTH[a.risk] || b.areaM2 - a.areaM2 || a.id.localeCompare(b.id),
    );
}

function riskZone(
    risk: Risk,
    cells: Cell[],
    toLatLng: (col: number, row: number) => LatLng,
    ids: Set<string>,
): RiskZone {
    let [minRow, maxRow, minCol, maxCol] = [Infinity, -Infinity, Infinity, -Infinity];
    let [sumRow, sumCol, confidence, first, last] = [0, 0, 0, Infinity, -Infinity];
    const corners: Pair[] = [];
    const detections = new Set<string>();
    const drones = new Set<string>();
    for (const c of cells) {
        minRow = Math.min(minRow, c.row);
        maxRow = Math.max(maxRow, c.row);
        minCol = Math.min(minCol, c.col);
        maxCol = Math.max(maxCol, c.col);
        sumRow += c.row + 0.5;
        sumCol += c.col + 0.5;
        confidence = Math.max(confidence, c.confidence);
        first = Math.min(first, c.first);
        last = Math.max(last, c.last);
        corners.push(
            [c.col, c.row],
            [c.col + 1, c.row],
            [c.col, c.row + 1],
            [c.col + 1, c.row + 1],
        );
        for (const d of c.detections) detections.add(d);
        for (const d of c.drones) drones.add(d);
    }
    let id = `${risk}:${minRow}:${minCol}`;
    for (let n = 2; ids.has(id); n++) id = `${risk}:${minRow}:${minCol}:${n}`;
    ids.add(id);
    const sw = toLatLng(minCol, minRow);
    const ne = toLatLng(maxCol + 1, maxRow + 1);
    return {
        id,
        risk,
        polygon: convexHull(corners).map(([col, row]) => toLatLng(col, row)),
        confidence,
        observedAt: new Date(last).toISOString(),
        bbox: { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng },
        center: toLatLng(sumCol / cells.length, sumRow / cells.length),
        areaM2: cells.length * CELL_M * CELL_M,
        firstSeenAt: new Date(first).toISOString(),
        detections: detections.size,
        droneIds: [...drones].toSorted(),
    };
}
