import { describe, expect, it } from 'vitest';
import { nearestColour } from './buildings';

const PALETTE = [0xb5523b, 0x4f7a5a, 0xb8bcc0];

describe('nearestColour', () => {
    it('snaps a roof seen in imagery to the palette colour of its hue', () => {
        expect(nearestColour(PALETTE, [0.5, 0.25, 0.2])).toBe(0xb5523b);
        expect(nearestColour(PALETTE, [0.2, 0.36, 0.25])).toBe(0x4f7a5a);
        expect(nearestColour(PALETTE, [0.55, 0.56, 0.58])).toBe(0xb8bcc0);
    });
});
