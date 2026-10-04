import { describe, expect, it } from 'vitest';
import type { Building } from './assets';
import { decompose, layout, minAreaRect, roadFinder, ruinFor } from './footprints';
import type { KitModel, Placement } from './footprints';

const KIT: KitModel[] = [
    { kind: 'house', lengthM: 8, widthM: 6, wallHeightM: 3.25 },
    { kind: 'house', lengthM: 17, widthM: 12, wallHeightM: 3.25 },
    { kind: 'house', lengthM: 18, widthM: 12, wallHeightM: 6.05 },
    { kind: 'block', lengthM: 12, widthM: 9, wallHeightM: 3.75 },
    { kind: 'block', lengthM: 8, widthM: 13, wallHeightM: 6.85 },
    { kind: 'block', lengthM: 36, widthM: 22, wallHeightM: 6.85 },
    { kind: 'ruin', lengthM: 8, widthM: 6, wallHeightM: 0 },
    { kind: 'ruin', lengthM: 22, widthM: 14, wallHeightM: 0 },
];

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

const L_SHAPE: [number, number][] = [
    [0, 0],
    [20, 0],
    [20, 6],
    [6, 6],
    [6, 20],
    [0, 20],
];

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

const gable = (lengthM: number, widthM: number, heightM = 3.5) =>
    building({ roof: 'gable', heightM, gable: { cx: 5, cy: 6, lengthM, widthM, angleRad: 0 } });
const noRoad = () => null;
const covered = (placements: Placement[]) =>
    placements.reduce((sum, p) => sum + p.rect.lengthM * p.rect.widthM, 0);
/** The world direction a placement's front faces. */
const front = (p: Placement) => [Math.sin(p.rect.angleRad), -Math.cos(p.rect.angleRad)];

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
        expect(minAreaRect(L_SHAPE).fill).toBeLessThan(0.6);
    });
});

describe('decompose', () => {
    it('covers an L-shaped footprint with its two wings', () => {
        const rects = decompose(L_SHAPE, minAreaRect(L_SHAPE));
        expect(rects).toHaveLength(2);
        const total = rects.reduce((sum, r) => sum + r.lengthM * r.widthM, 0);
        expect(total).toBeGreaterThan(0.9 * 204);
        expect(total).toBeLessThan(1.1 * 204);
        for (const r of rects) {
            expect(r.cx).toBeGreaterThan(0);
            expect(r.cx).toBeLessThan(20);
            expect(r.cy).toBeGreaterThan(0);
            expect(r.cy).toBeLessThan(20);
        }
    });
});

describe('roadFinder', () => {
    it('gives the offset to the nearest point of a road, or null far from any', () => {
        const find = roadFinder([
            {
                widthM: 6,
                points: [
                    [0, 50],
                    [200, 50],
                ],
            },
        ]);
        const to = find(120, 20)!;
        expect(to[0]).toBeCloseTo(0, 6);
        expect(to[1]).toBeCloseTo(30, 6);
        expect(find(120, 900)).toBeNull();
    });
});

describe('layout', () => {
    it('gives a house the model nearest its size and wall height', () => {
        const [single, ...rest] = layout(gable(16, 11), KIT, noRoad);
        expect(rest).toHaveLength(0);
        expect(single!.model).toBe(1);
        expect(single!.rect).toMatchObject({ cx: 5, cy: 6, lengthM: 16, widthM: 11 });
        expect(layout(gable(16, 11, 6.5), KIT, noRoad)[0]!.model).toBe(2);
        expect(layout(gable(4.4, 3.2), KIT, noRoad)[0]!.model).toBe(0);
    });

    it('turns the front of a house to the road', () => {
        const south = layout(gable(16, 11), KIT, () => [0, -20])[0]!;
        const north = layout(gable(16, 11), KIT, () => [0, 20])[0]!;
        expect(front(south)[1]).toBeCloseTo(-1, 6);
        expect(front(north)[1]).toBeCloseTo(1, 6);
    });

    it('fronts a deep shop on the street, whichever side that is', () => {
        const shop = building({ footprint: rectangle(0, 0, 8, 13, 0), heightM: 6.8 });
        const [north] = layout(shop, KIT, () => [0, 15]);
        expect(north!.model).toBe(4);
        expect(front(north!)[1]).toBeCloseTo(1, 6);
        expect(north!.rect.lengthM).toBeCloseTo(8, 6);
        // With the street on its long side it is a wide, shallow shop instead.
        const [east] = layout(shop, KIT, () => [15, 0]);
        expect(east!.model).toBe(3);
        expect(front(east!)[0]).toBeCloseTo(1, 6);
        expect(east!.rect.lengthM).toBeCloseTo(13, 6);
    });

    it('covers a footprint too large for any model with a row of them', () => {
        const hall = building({ footprint: rectangle(100, 50, 110, 44, 0.3), heightM: 7 });
        const placements = layout(hall, KIT, noRoad);
        expect(placements.length).toBeGreaterThan(1);
        expect(covered(placements)).toBeCloseTo(110 * 44, 3);
        for (const p of placements) {
            expect(p.rect.lengthM / KIT[p.model]!.lengthM).toBeGreaterThan(0.6);
            expect(p.rect.lengthM / KIT[p.model]!.lengthM).toBeLessThan(1.6);
            expect(p.heightScale).toBeGreaterThanOrEqual(0.8);
            expect(p.heightScale).toBeLessThanOrEqual(1.35);
        }
    });

    it('covers an irregular footprint wing by wing', () => {
        const placements = layout(building({ footprint: L_SHAPE }), KIT, noRoad);
        expect(placements.length).toBeGreaterThanOrEqual(2);
        expect(covered(placements)).toBeGreaterThan(0.9 * 204);
    });

    it('finds a model for every footprint, however small', () => {
        const hut = building({ footprint: rectangle(0, 0, 3, 2.5, 1) });
        expect(layout(hut, KIT, noRoad)).toHaveLength(1);
    });
});

describe('ruinFor', () => {
    it('takes the ruin nearest the footprint in size', () => {
        const rect = { cx: 0, cy: 0, lengthM: 20, widthM: 12, angleRad: 0 };
        expect(ruinFor(KIT, rect, 1)).toBe(7);
        expect(ruinFor(KIT, { ...rect, lengthM: 7, widthM: 6 }, 1)).toBe(6);
    });
});
