import type { LatLng } from '@ember/contracts';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function distanceM(a: LatLng, b: LatLng): number {
    const dLat = (b.lat - a.lat) * RAD;
    const dLng = (b.lng - a.lng) * RAD;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting on lat/lng; fine at the few-kilometre scale of a watch zone. */
export function contains(ring: LatLng[], p: LatLng): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (
            a.lat > p.lat !== b.lat > p.lat &&
            p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng
        ) {
            inside = !inside;
        }
    }
    return inside;
}

export function circle(center: LatLng, radiusM: number, sides = 32): LatLng[] {
    const dLat = radiusM / (EARTH_RADIUS_M * RAD);
    const dLng = dLat / Math.cos(center.lat * RAD);
    return Array.from({ length: sides }, (_, k) => {
        const t = (2 * Math.PI * k) / sides;
        return { lat: center.lat + dLat * Math.cos(t), lng: center.lng + dLng * Math.sin(t) };
    });
}

/** Local metres east and north of `origin`. */
function local(origin: LatLng, p: LatLng): [number, number] {
    return [
        (p.lng - origin.lng) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD),
        (p.lat - origin.lat) * RAD * EARTH_RADIUS_M,
    ];
}

export function areaHa(ring: LatLng[]): number {
    if (ring.length < 3) return 0;
    const origin = ring[0]!;
    let twice = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = local(origin, ring[i]!);
        const [x2, y2] = local(origin, ring[(i + 1) % ring.length]!);
        twice += x1 * y2 - x2 * y1;
    }
    return Math.abs(twice) / 2 / 10_000;
}

/** Area-weighted centroid; the vertex mean for degenerate rings. */
export function centroid(ring: LatLng[]): LatLng {
    const origin = ring[0]!;
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = local(origin, ring[i]!);
        const [x2, y2] = local(origin, ring[(i + 1) % ring.length]!);
        const cross = x1 * y2 - x2 * y1;
        a += cross;
        cx += (x1 + x2) * cross;
        cy += (y1 + y2) * cross;
    }
    if (Math.abs(a) < 1e-9) {
        return {
            lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
            lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length,
        };
    }
    cx /= 3 * a;
    cy /= 3 * a;
    return {
        lat: origin.lat + cy / (EARTH_RADIUS_M * RAD),
        lng: origin.lng + cx / (EARTH_RADIUS_M * RAD * Math.cos(origin.lat * RAD)),
    };
}

const COMPASS = [
    'north',
    'northeast',
    'east',
    'southeast',
    'south',
    'southwest',
    'west',
    'northwest',
] as const;

export function compass(deg: number): (typeof COMPASS)[number] {
    return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}
