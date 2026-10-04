import { expect, test } from 'vitest';
import type { LatLng } from '@ember/contracts';
import {
    centroid,
    compassPoint,
    coverage,
    insideRing,
    projection,
    siteName,
    suggestSites,
} from './geo.js';

const origin = { lat: 20.88, lng: -156.68 };
const proj = projection(origin);
const at = (x: number, y: number) => proj.toLatLng({ x, y });
/** A square `sideM` across, centred on `origin`. */
const square = (sideM: number): LatLng[] => {
    const h = sideM / 2;
    return [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
};

test('the projection round-trips and measures metres', () => {
    const p = at(1000, -500);
    const back = proj.toXY(p);
    expect(back.x).toBeCloseTo(1000, 6);
    expect(back.y).toBeCloseTo(-500, 6);
    expect((p.lat - origin.lat) * 111_195).toBeCloseTo(-500, 0);
});

test('centroid and even-odd inside', () => {
    const c = centroid(square(2000));
    expect(c.lat).toBeCloseTo(origin.lat, 9);
    expect(c.lng).toBeCloseTo(origin.lng, 9);
    const ring = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ];
    expect(insideRing({ x: 5, y: 5 }, ring)).toBe(true);
    expect(insideRing({ x: 15, y: 5 }, ring)).toBe(false);
});

test('coverage is the share of the zone inside any circle', () => {
    const zone = square(2000);
    expect(coverage(zone, [])).toBe(0);
    expect(coverage(zone, [{ center: origin, radiusM: 5000 }])).toBe(1);
    // A 1 km circle in a 2 km square covers pi / 4 of it.
    expect(coverage(zone, [{ center: origin, radiusM: 1000 }])).toBeCloseTo(Math.PI / 4, 1);
    const twice = coverage(zone, [
        { center: origin, radiusM: 1000 },
        { center: origin, radiusM: 1000 },
    ]);
    expect(twice).toBeCloseTo(Math.PI / 4, 1);
    expect(coverage(zone, [{ center: at(5000, 5000), radiusM: 500 }])).toBe(0);
});

test('suggestions reach the target with sites inside the zone', () => {
    const zone = square(2000);
    const ring = zone.map(proj.toXY);
    const result = suggestSites(zone, [], { targetCoverage: 0.92, radiusM: 500 });
    expect(result.coverage).toBe(0);
    expect(result.projectedCoverage).toBeGreaterThanOrEqual(0.92);
    expect(result.sites.length).toBeGreaterThanOrEqual(5);
    expect(result.sites.length).toBeLessThanOrEqual(16);
    for (const site of result.sites) expect(insideRing(proj.toXY(site), ring)).toBe(true);
    const check = coverage(
        zone,
        result.sites.map((center) => ({ center, radiusM: 500 })),
    );
    expect(check).toBeCloseTo(result.projectedCoverage, 1);
});

test('deployed edge servers count first', () => {
    const zone = square(2000);
    const covered = suggestSites(zone, [{ center: origin, radiusM: 3000 }], {
        targetCoverage: 0.92,
        radiusM: 500,
    });
    expect(covered).toEqual({ sites: [], coverage: 1, projectedCoverage: 1 });
    const half = suggestSites(zone, [{ center: at(-1000, 0), radiusM: 1000 }], {
        targetCoverage: 0.92,
        radiusM: 500,
    });
    const fresh = suggestSites(zone, [], { targetCoverage: 0.92, radiusM: 500 });
    expect(half.coverage).toBeGreaterThan(0.3);
    expect(half.sites.length).toBeLessThan(fresh.sites.length);
});

test('suggestions stop at 60 sites and when a site adds too little', () => {
    const big = suggestSites(square(10_000), [], { targetCoverage: 1, radiusM: 600 });
    expect(big.sites.length).toBe(60);
    // One 200 m site is far under 0.5% of a 20 km square.
    const tiny = suggestSites(square(20_000), [], { targetCoverage: 1, radiusM: 200 });
    expect(tiny.sites).toEqual([]);
    const full = suggestSites(square(2000), [], { targetCoverage: 1, radiusM: 500 });
    expect(full.sites.length).toBeLessThan(60);
    expect(full.projectedCoverage).toBeGreaterThan(0.95);
});

test('site names are a compass point from the centre and the lowest free number', () => {
    expect(compassPoint(origin, at(0, 100))).toBe('N');
    expect(compassPoint(origin, at(100, 100))).toBe('NE');
    expect(compassPoint(origin, at(100, 0))).toBe('E');
    expect(compassPoint(origin, at(-100, -100))).toBe('SW');
    expect(compassPoint(origin, origin)).toBe('N');
    const taken = new Set(['NE-1', 'NE-3']);
    expect(siteName(origin, at(100, 100), taken)).toBe('NE-2');
    expect(siteName(origin, at(100, 100), taken)).toBe('NE-4');
    expect(siteName(origin, at(-100, 0), taken)).toBe('W-1');
    expect(taken).toEqual(new Set(['NE-1', 'NE-2', 'NE-3', 'NE-4', 'W-1']));
});
