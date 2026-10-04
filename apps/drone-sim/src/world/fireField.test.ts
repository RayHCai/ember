import { describe, expect, it } from 'vitest';
import type { FireGrid } from './assets';
import { cellState, FireField } from './fireField';

// arrival 0, flames 10 min, smoulder 20 min, full heat.
const at = (minute: number) => cellState(0, 10, 20, 1, minute);

describe('cellState (Demo Data model/state.py)', () => {
    it('is cold and pre-fire before the front arrives', () => {
        expect(at(-1)).toEqual({ intensity: 0, smoulder: 0, post: 0 });
    });

    it('builds up fast and decays slowly while flaming', () => {
        // heat * min(1, x / 0.12) * sqrt(1 - x) * 1.1 with x = since / flame
        expect(at(0.6).intensity).toBeCloseTo(0.5 * Math.sqrt(0.94) * 1.1, 6);
        expect(at(5).intensity).toBeCloseTo(Math.sqrt(0.5) * 1.1, 6);
        expect(at(5).smoulder).toBe(0);
    });

    it('smoulders after the flames, decaying exponentially', () => {
        const s = at(12);
        expect(s.intensity).toBe(0);
        expect(s.smoulder).toBeCloseTo(0.6 * Math.exp(-0.3), 6);
        expect(at(31).smoulder).toBe(0);
    });

    it('reveals the post-fire surface from halfway through the flames', () => {
        expect(at(5).post).toBe(0);
        expect(at(7.5).post).toBeCloseTo(0.5, 6);
        expect(at(40).post).toBe(1);
    });

    it('never burns a cell with no heat', () => {
        expect(cellState(0, 10, 20, 0, 5)).toEqual({ intensity: 0, smoulder: 0, post: 0 });
    });
});

describe('FireField', () => {
    it('lists burning and smouldering cells and fills the texture', () => {
        const width = 3;
        const height = 1;
        const cells = new Float32Array([0, 10, 20, 1, 100, 10, 20, 1, -15, 10, 20, 1]);
        const grid: FireGrid = {
            width,
            height,
            cellM: 10,
            extent: { minX: 0, minY: 0, maxX: 30, maxY: 10 },
            neverMin: 1e6,
            cells,
            fuel: new Uint8Array([1, 1, 1]),
        };
        const field = new FireField(grid);
        field.update(5);
        expect(Array.from(field.burning.slice(0, field.burningCount))).toEqual([0]);
        expect(Array.from(field.smouldering.slice(0, field.smoulderingCount))).toEqual([2]);
        expect(field.texture[0]).toBe(Math.round(Math.sqrt(0.5) * 1.1 * 255));
        expect(field.texture[2 * 4 + 2]).toBe(255);
        expect(field.cellCentre(2)).toEqual({ x: 25, y: 5 });
    });
});
