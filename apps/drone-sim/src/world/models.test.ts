/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Group } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { bake, buildingModel, buildingNames } from './models';

const ASSETS = fileURLToPath(new URL('../../../../assets/', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(`${ASSETS}manifest.json`, 'utf8')).assets as Record<
    string,
    Record<string, unknown> & { triangles: number }
>;

async function scene(name: string): Promise<Group> {
    const buf = readFileSync(`${ASSETS}${name}.glb`);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return (await new GLTFLoader().parseAsync(data, '')).scene;
}

describe('bake', () => {
    it.each(Object.keys(MANIFEST).filter((k) => !k.startsWith('drone/')))(
        '%s keeps every faceted triangle and the sizes in its extras',
        async (name) => {
            const { geometry, size } = bake(await scene(name));
            const entry = MANIFEST[name]!;
            expect(geometry.index).toBeNull();
            expect(geometry.getAttribute('position').count).toBe(entry.triangles * 3);
            const sizes = Object.fromEntries(
                ['heightM', 'crownRadiusM', 'lengthM', 'widthM', 'wallHeightM', 'radiusM']
                    .filter((key) => typeof entry[key] === 'number')
                    .map((key) => [key, entry[key]]),
            );
            expect(size).toMatchObject(sizes);
        },
    );

    it('leaves recoloured parts only their face tint, for the instance colour to multiply', async () => {
        const root = await scene('trees/palm_a');
        const plain = bake(root);
        const tinted = bake(root, ['foliage']);
        expect(tinted.colours.foliage!.g).toBeGreaterThan(tinted.colours.foliage!.r);
        const part = tinted.geometry.getAttribute('part');
        const a = plain.geometry.getAttribute('color');
        const b = tinted.geometry.getAttribute('color');
        const all = Array.from({ length: part.count }, (_, i) => i);
        const foliage = all.filter((i) => part.getX(i) === 1);
        const bark = all.filter((i) => part.getX(i) === 0);
        expect(foliage.length).toBeGreaterThan(0);
        expect(bark.length).toBeGreaterThan(0);
        expect(foliage.every((i) => b.getY(i) > a.getY(i))).toBe(true);
        expect(bark.every((i) => b.getY(i) === a.getY(i))).toBe(true);
    });
});

describe('building kit', () => {
    const names = buildingNames(Object.keys(MANIFEST).map((k) => `../../../../assets/${k}.glb`));

    it('lists every building once, without its far model', () => {
        expect(names).toContain('house_17x12');
        expect(names.some((n) => n.endsWith('_lod1'))).toBe(false);
        expect(names).toHaveLength(
            Object.keys(MANIFEST).filter((k) => k.startsWith('buildings/')).length / 2,
        );
    });

    it.each(names)('%s says what it is and what footprint it was made for', async (name) => {
        const model = buildingModel(
            name,
            await scene(`buildings/${name}`),
            await scene(`buildings/${name}_lod1`),
        );
        const entry = MANIFEST[`buildings/${name}`]!;
        expect(model.kind).toBe(entry.kind);
        expect(model.lengthM).toBe(entry.lengthM);
        expect(model.widthM).toBe(entry.widthM);
        const parts = new Set(model.lod.geometry.getAttribute('part').array);
        // Roof and wall are recoloured per building; a ruin is drawn as modelled.
        expect([...parts].toSorted()).toEqual(model.kind === 'ruin' ? [0] : [0, 1, 2]);
        expect(model.wallHeightM > 2).toBe(model.kind !== 'ruin');
    });
});

describe('quadcopter', () => {
    it('has the gimbal and propellers marker.ts drives, with its front towards +Z', async () => {
        const drone = await scene('drone/quadcopter');
        expect(drone.getObjectByName('gimbal')).toBeDefined();
        for (const side of ['left', 'right']) {
            expect(drone.getObjectByName(`propeller_front_${side}`)!.position.z).toBeGreaterThan(0);
            expect(drone.getObjectByName(`propeller_rear_${side}`)!.position.z).toBeLessThan(0);
            expect(drone.getObjectByName(`rotor_blur_front_${side}`)).toBeDefined();
        }
    });
});
