import type { LatLng } from '@ember/contracts';

const M_PER_DEG_LAT = 111_320;

export type Point = { x: number; y: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Local equirectangular projection in metres around `origin`, y pointing south so it matches
 * screen space. Accurate to well under a pixel across a watch zone.
 */
export type Projection = {
    origin: LatLng;
    toXY: (p: LatLng) => Point;
    toLatLng: (p: Point) => LatLng;
};

export function makeProjection(origin: LatLng): Projection {
    const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
    return {
        origin,
        toXY: (p) => ({
            x: (p.lng - origin.lng) * mPerDegLng,
            y: (origin.lat - p.lat) * M_PER_DEG_LAT,
        }),
        toLatLng: (p) => ({
            lat: origin.lat - p.y / M_PER_DEG_LAT,
            lng: origin.lng + p.x / mPerDegLng,
        }),
    };
}

export function centroid(points: LatLng[]): LatLng {
    if (points.length === 0) return { lat: 0, lng: 0 };
    let lat = 0;
    let lng = 0;
    for (const p of points) {
        lat += p.lat;
        lng += p.lng;
    }
    return { lat: lat / points.length, lng: lng / points.length };
}

export function boundsOf(points: Point[]): Bounds {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of points) {
        if (p.x < b.minX) b.minX = p.x;
        if (p.y < b.minY) b.minY = p.y;
        if (p.x > b.maxX) b.maxX = p.x;
        if (p.y > b.maxY) b.maxY = p.y;
    }
    return b;
}

/** Map camera: the world point at the screen centre and screen pixels per metre. */
export type Camera = { cx: number; cy: number; scale: number };

export type Size = { width: number; height: number };

export function fitCamera(b: Bounds, size: Size, paddingPx: number): Camera {
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const scale = Math.min((size.width - paddingPx * 2) / w, (size.height - paddingPx * 2) / h);
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.max(scale, 1e-4) };
}

export function screenToWorld(cam: Camera, size: Size, s: Point): Point {
    return {
        x: cam.cx + (s.x - size.width / 2) / cam.scale,
        y: cam.cy + (s.y - size.height / 2) / cam.scale,
    };
}

export function pathD(points: Point[], closed: boolean): string {
    let d = '';
    for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    return closed && d ? `${d}Z` : d;
}

export function distanceM(a: LatLng, b: LatLng): number {
    const r = 6_371_000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) *
            Math.cos((b.lat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
}
