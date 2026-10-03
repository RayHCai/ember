import { describe, expect, it } from 'vitest';
import type { Building } from './assets';
import { minAreaRect, placement } from './buildings';

// The footprints in assets/manifest.json.
const MODELS = {
    house_gable: { lengthM: 11, widthM: 7.6 },
    house_hip: { lengthM: 9.6, widthM: 8 },
    shop: { lengthM: 12, widthM: 9 },
};

function rectangle(cx: number, cy: number, l: number, w: number, a: number): [number, number][] {
    const u = [Math.cos(a), Math.sin(a)] as const;
    const v = [-u[1], u[0]] as const;
    return [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
    ].map(([s, t]) => [
        cx + (u[0] * l * s! + v[0] * w * t!) / 2,
        cy + (u[1] * l * s! + v[1] * w * t!) / 2,
    ]);
}

function building(over: Partial<Building>): Building {
    return {
        id: 1,
        footprint: rectangle(0, 0, 10, 8, 0),
        heightM: 3.5,
        roof: 'flat',
        roofRgb: [0.5, 0.4, 0.3],
        ignitionMin: null,
        flameMin: 110,
        destroyed: false,
        ...over,
    };
}

describe('minAreaRect', () => {
    it('recovers a rotated rectangle, angle along its long side', () => {
        const r = minAreaRect(rectangle(30, -12, 20, 9, 0.6));
        expect(r.cx).toBeCloseTo(30, 6);
        expect(r.cy).toBeCloseTo(-12, 6);
        expect(r.lengthM).toBeCloseTo(20, 6);
        expect(r.widthM).toBeCloseTo(9, 6);
        expect(Math.abs(Math.sin(r.angleRad - 0.6))).toBeLessThan(1e-6);
        expect(r.fill).toBeCloseTo(1, 6);
    });

    it('reports how little of its box an L-shaped footprint fills', () => {
        const l: [number, number][] = [
            [0, 0],
            [20, 0],
            [20, 6],
            [6, 6],
            [6, 20],
            [0, 20],
        ];
        expect(minAreaRect(l).fill).toBeLessThan(0.6);
    });
});

const place = (b: Building) => placement(b, MODELS);
const gable = (lengthM: number, widthM: number) =>
    building({ roof: 'gable', gable: { cx: 5, cy: 6, lengthM, widthM, angleRad: 0.3 } });

describe('placement', () => {
    it('gives each house the model that fits its proportions better', () => {
        expect(place(gable(9, 8))?.kind).toBe('house_hip');
        expect(place(gable(15, 9))).toEqual({
            kind: 'house_gable',
            rect: { cx: 5, cy: 6, lengthM: 15, widthM: 9, angleRad: 0.3 },
        });
    });

    it('extrudes houses a model would have to stretch or shrink far to cover', () => {
        expect(place(gable(30, 8))).toBeNull();
        expect(place(gable(4, 3))).toBeNull();
    });

    it('makes rectangular, shop-sized flat roofs shops', () => {
        const p = place(building({ footprint: rectangle(100, 50, 18, 12, -0.4) }));
        expect(p?.kind).toBe('shop');
        expect(p?.rect.lengthM).toBeCloseTo(18, 6);
    });

    it('extrudes large or irregular footprints', () => {
        expect(place(building({ footprint: rectangle(0, 0, 60, 40, 0) }))).toBeNull();
        const l: [number, number][] = [
            [0, 0],
            [20, 0],
            [20, 6],
            [6, 6],
            [6, 20],
            [0, 20],
        ];
        expect(place(building({ footprint: l }))).toBeNull();
    });
});
