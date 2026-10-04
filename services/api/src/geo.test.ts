import { expect, test } from 'vitest';
import { areaHa, centroid, circle, compass, contains, distanceM } from './geo.js';

const C = { lat: 20.875, lng: -156.675 };

test('a circle has the area and centre it was drawn with', () => {
    const ring = circle(C, 1000, 64);
    expect(areaHa(ring)).toBeCloseTo((Math.PI * 1000 ** 2) / 10_000, -1);
    expect(distanceM(centroid(ring), C)).toBeLessThan(1);
    expect(contains(ring, C)).toBe(true);
    expect(contains(ring, { lat: C.lat + 0.02, lng: C.lng })).toBe(false);
});

test('compass words', () => {
    expect([0, 44, 135, 200, 359].map(compass)).toEqual([
        'north',
        'northeast',
        'southeast',
        'south',
        'north',
    ]);
});
