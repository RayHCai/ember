import type { LatLng, Road } from '@ember/contracts';

const EARTH_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.sqrt(h));
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
];

/** Degrees clockwise from north, as a word. */
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;

/** A route point this close to a road's vertex counts as being on it. */
const ON_ROAD_M = 40;
const MAX_SAMPLES = 80;

/**
 * The named roads a route runs along, in order and without repeats in a row. Routes carry only
 * points, so each sampled point takes the name of the nearest road vertex within `ON_ROAD_M`.
 */
export function roadNamesAlong(path: LatLng[], roads: Road[], max = 3): string[] {
    const named = roads.filter((r) => r.name);
    if (!path.length || !named.length) return [];
    const step = Math.max(1, Math.ceil(path.length / MAX_SAMPLES));
    const names: string[] = [];
    for (let i = 0; i < path.length; i += step) {
        const p = path[i]!;
        let best: { name: string; d: number } | null = null;
        for (const road of named) {
            for (const v of road.path) {
                const d = distanceM(p, v);
                if (d <= ON_ROAD_M && (!best || d < best.d)) best = { name: road.name!, d };
            }
        }
        if (best && names.at(-1) !== best.name) names.push(best.name);
    }
    return [...new Set(names)].slice(0, max);
}

export type ZipLookup = (at: LatLng) => Promise<string | null>;

/**
 * OpenStreetMap Nominatim reverse geocoding, reduced to a US ZIP. One request a second as its
 * usage policy asks, and each point is asked once.
 */
export function nominatimZip(userAgent: string, fetchImpl: typeof fetch = fetch): ZipLookup {
    const cache = new Map<string, Promise<string | null>>();
    let last = Promise.resolve();
    return (at) => {
        const key = `${at.lat.toFixed(4)},${at.lng.toFixed(4)}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const lookup = last.then(async () => {
            const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
                lat: String(at.lat),
                lon: String(at.lng),
                format: 'jsonv2',
                zoom: '16',
                addressdetails: '1',
            })}`;
            const res = await fetchImpl(url, {
                headers: { 'user-agent': userAgent },
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) throw new Error(`nominatim: ${res.status}`);
            const body = (await res.json()) as { address?: { postcode?: string } };
            return /^\d{5}/.exec(body.address?.postcode ?? '')?.[0] ?? null;
        });
        last = lookup.then(
            () => new Promise((r) => setTimeout(r, 1_100)),
            () => new Promise((r) => setTimeout(r, 1_100)),
        );
        cache.set(key, lookup);
        // A failed lookup is asked again on a later tick.
        lookup.catch(() => cache.delete(key));
        return lookup;
    };
}
