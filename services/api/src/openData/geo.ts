import type { LatLng } from '@ember/contracts';

export type Point = { x: number; y: number };
export type Bounds = { south: number; west: number; north: number; east: number };

const METRES_PER_DEGREE = (Math.PI / 180) * 6_371_008.8;
const cosLat = (lat: number) => Math.cos((lat * Math.PI) / 180);

export function boundsOf(points: readonly LatLng[]): Bounds {
    const bounds = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
    for (const { lat, lng } of points) {
        bounds.south = Math.min(bounds.south, lat);
        bounds.north = Math.max(bounds.north, lat);
        bounds.west = Math.min(bounds.west, lng);
        bounds.east = Math.max(bounds.east, lng);
    }
    return bounds;
}

export function sizeM(bounds: Bounds): { widthM: number; heightM: number } {
    const lat = (bounds.south + bounds.north) / 2;
    return {
        widthM: (bounds.east - bounds.west) * cosLat(lat) * METRES_PER_DEGREE,
        heightM: (bounds.north - bounds.south) * METRES_PER_DEGREE,
    };
}

export function growBounds(bounds: Bounds, marginLatM: number, marginLngM = marginLatM): Bounds {
    const lat = (bounds.south + bounds.north) / 2;
    const dLat = marginLatM / METRES_PER_DEGREE;
    const dLng = marginLngM / (METRES_PER_DEGREE * cosLat(lat));
    return {
        south: bounds.south - dLat,
        west: bounds.west - dLng,
        north: bounds.north + dLat,
        east: bounds.east + dLng,
    };
}

export function inBounds(bounds: Bounds, at: LatLng): boolean {
    return (
        at.lat >= bounds.south &&
        at.lat <= bounds.north &&
        at.lng >= bounds.west &&
        at.lng <= bounds.east
    );
}

/** Equirectangular metres around `origin`: x east, y north. */
export function projection(origin: LatLng) {
    const scale = cosLat(origin.lat) * METRES_PER_DEGREE;
    return {
        toLocal: (at: LatLng): Point => ({
            x: (at.lng - origin.lng) * scale,
            y: (at.lat - origin.lat) * METRES_PER_DEGREE,
        }),
        toLatLng: (at: Point): LatLng => ({
            lat: origin.lat + at.y / METRES_PER_DEGREE,
            lng: origin.lng + at.x / scale,
        }),
    };
}

export function distanceM(a: LatLng, b: LatLng): number {
    const dx = (b.lng - a.lng) * cosLat((a.lat + b.lat) / 2) * METRES_PER_DEGREE;
    const dy = (b.lat - a.lat) * METRES_PER_DEGREE;
    return Math.hypot(dx, dy);
}

/** Even-odd test, planar in degrees: fine at the scale of a zone. */
export function contains(ring: readonly LatLng[], at: LatLng): boolean {
    let inside = false;
    for (let k = 0, prev = ring.length - 1; k < ring.length; prev = k++) {
        const a = ring[k];
        const b = ring[prev];
        if (!a || !b) continue;
        if (a.lat > at.lat !== b.lat > at.lat) {
            const lngAtLat = a.lng + ((at.lat - a.lat) * (b.lng - a.lng)) / (b.lat - a.lat);
            if (at.lng < lngAtLat) inside = !inside;
        }
    }
    return inside;
}

export function polygonAreaM2(ring: readonly Point[]): number {
    let twice = 0;
    for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (a && b) twice += a.x * b.y - b.x * a.y;
    }
    return Math.abs(twice) / 2;
}

export function areaM2(ring: readonly LatLng[]): number {
    const first = ring[0];
    if (!first) return 0;
    const local = projection(first).toLocal;
    return polygonAreaM2(ring.map((at) => local(at)));
}

/** Area centroid, falling back to the vertex mean for a degenerate ring. */
export function centroid(ring: readonly LatLng[]): LatLng {
    const first = ring[0];
    if (!first) return { lat: 0, lng: 0 };
    const { toLocal, toLatLng } = projection(first);
    const points = ring.map((at) => toLocal(at));
    let twice = 0;
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < points.length; k++) {
        const a = points[k];
        const b = points[(k + 1) % points.length];
        if (!a || !b) continue;
        const cross = a.x * b.y - b.x * a.y;
        twice += cross;
        cx += (a.x + b.x) * cross;
        cy += (a.y + b.y) * cross;
    }
    if (Math.abs(twice) < 1e-9) {
        const n = points.length;
        const sum = points.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
        return toLatLng({ x: sum.x / n, y: sum.y / n });
    }
    return toLatLng({ x: cx / (3 * twice), y: cy / (3 * twice) });
}

function segmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t =
        lengthSq === 0
            ? 0
            : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function simplifyPath(points: readonly Point[], tolerance: number): Point[] {
    const last = points.length - 1;
    if (last < 2) return [...points];
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[last] = 1;
    const stack: [number, number][] = [[0, last]];
    for (let range = stack.pop(); range; range = stack.pop()) {
        const [from, to] = range;
        const a = points[from];
        const b = points[to];
        if (!a || !b) continue;
        let worst = -1;
        let worstDistance = tolerance;
        for (let k = from + 1; k < to; k++) {
            const p = points[k];
            if (!p) continue;
            const d = segmentDistance(p, a, b);
            if (d > worstDistance) {
                worst = k;
                worstDistance = d;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push([from, worst], [worst, to]);
        }
    }
    return points.filter((_, k) => keep[k] === 1);
}

/** Douglas-Peucker on a closed ring (first point not repeated), anchored at the farthest pair. */
export function simplifyRing(ring: readonly Point[], tolerance: number): Point[] {
    const origin = ring[0];
    if (!origin || ring.length < 4) return [...ring];
    let far = 1;
    let farDistance = -1;
    ring.forEach((p, k) => {
        const d = Math.hypot(p.x - origin.x, p.y - origin.y);
        if (d > farDistance) {
            far = k;
            farDistance = d;
        }
    });
    const first = simplifyPath(ring.slice(0, far + 1), tolerance);
    const second = simplifyPath([...ring.slice(far), origin], tolerance);
    return [...first, ...second.slice(1, -1)];
}
