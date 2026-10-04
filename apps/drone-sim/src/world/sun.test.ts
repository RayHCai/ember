import { describe, expect, it } from 'vitest';
import { daylight, sunPosition } from './sun';

// Reference elevations from Demo Data's render/sun.py at the coverage-box centre.
const LAT = 20.8765;
const LNG = -156.6675;

describe('sunPosition', () => {
    it.each([
        ['2023-08-08T12:00:00-10:00', 80.9242],
        ['2023-08-08T17:30:00-10:00', 19.8171],
        ['2023-08-08T19:05:00-10:00', -1.726],
        ['2023-08-08T22:00:00-10:00', -37.5887],
    ])('matches Demo Data at %s', (iso, elevation) => {
        expect(sunPosition(LAT, LNG, Date.parse(iso)).elevationDeg).toBeCloseTo(elevation, 2);
    });

    it('sets in the west', () => {
        const { azimuthDeg } = sunPosition(LAT, LNG, Date.parse('2023-08-08T18:30:00-10:00'));
        expect(azimuthDeg).toBeGreaterThan(270);
        expect(azimuthDeg).toBeLessThan(300);
    });
});

describe('daylight', () => {
    it('follows the Demo Data curve', () => {
        expect(daylight(80)).toBe(1);
        expect(daylight(-1.726)).toBeCloseTo(0.3907, 3);
        expect(daylight(-40)).toBe(0.02);
    });
});
