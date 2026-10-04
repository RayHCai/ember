import {
    Color,
    DynamicDrawUsage,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    MeshLambertMaterial,
    Quaternion,
    Vector3,
} from 'three';
import type { Scene } from 'three';
import type { Building, Road } from './assets';
import { hash, layout, roadFinder, ruinFor } from './footprints';
import type { Rect } from './footprints';
import type { BakedModel, BuildingModel } from './models';
import { withVisibility } from './visibility';

const NEVER = 1.0e6;
const STRUCTURE_SMOULDER_MIN = 1080;
/** Buildings nearer the camera than this are drawn at full detail, the rest with their `_lod1`. */
const NEAR_M = 320;
/** Near and far are sorted again once the camera has moved this far. */
const REFRESH_M = 40;

// Imagery roof colours snap to the nearest of these, so the town keeps its real mix of red,
// green and grey roofs in clean tones. Pitched roofs, then flat roof decks.
const ROOFS = [0xb5523b, 0x96483a, 0x5e6e7a, 0x4a4e54, 0x4f7a5a, 0xc2a878, 0x7a5a44, 0xb8bcc0];
const DECKS = [0x9b9e9c, 0xb9b4a6, 0xd0d0ca, 0x74787b, 0x8f7663];
const WALLS = [0xefe6d2, 0xe2d4b4, 0xd9e2da, 0xc9d8e2, 0xf2f0ea, 0xe8d9a8, 0xd8c4b0, 0xbfc9b8];

const srgbOf = (hex: number): [number, number, number] => [
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
];

/** The palette colour nearest an imagery colour (sRGB, lifted: roofs in imagery are in shade). */
export function nearestColour(palette: readonly number[], rgb: [number, number, number]): number {
    const lift = 1.25;
    let best = palette[0]!;
    let bestD = Infinity;
    for (const hex of palette) {
        const [r, g, b] = srgbOf(hex);
        const d = (r - rgb[0] * lift) ** 2 + (g - rgb[1] * lift) ** 2 + (b - rgb[2] * lift) ** 2;
        if (d < bestD) {
            bestD = d;
            best = hex;
        }
    }
    return best;
}

const PARS = /* glsl */ `
attribute float part; // 0 as modelled, 1 roof, 2 wall
attribute vec3 aFire;
attribute vec3 aRoof;
attribute vec3 aWall;
uniform float uMinute;
uniform float uTime;
varying float vFireGlow;
varying float vEmber;
`;

// aFire = (ignition_min, flame_min, destroyed). Destroyed buildings burn, then collapse into
// their ruin, which keeps smouldering; survivors stand.
const COLOR = /* glsl */ `
float bSince = uMinute - aFire.x;
float bBurning = (bSince >= 0.0 && bSince < aFire.y) ? 1.0 : 0.0;
float bCollapse = aFire.z * smoothstep(0.35 * aFire.y, aFire.y, bSince);
vColor.rgb = color * (part > 1.5 ? aWall : part > 0.5 ? aRoof : vec3(1.0));
#ifndef RUIN
vColor.rgb = mix(vColor.rgb, vColor.rgb * 0.18, bBurning * smoothstep(0.0, 0.3, bSince / aFire.y));
vColor.rgb = mix(vColor.rgb, vec3(0.03, 0.028, 0.026), bCollapse);
#endif
float bFlick = 0.6 + 0.4 * sin(uTime * 7.0 + position.x * 0.9 + position.z * 1.3);
// Fire shows through walls and windows; roofs mostly read as dark and smoking.
vFireGlow = bBurning * smoothstep(0.0, 4.0, bSince) * bFlick * mix(0.15, 1.0, 1.0 - abs(normal.y));
float bEmber = (bSince - aFire.y) / ${STRUCTURE_SMOULDER_MIN.toFixed(1)};
vEmber = aFire.z * ((bEmber > 0.0 && bEmber < 1.0) ? exp(-3.0 * bEmber) : 0.0);
`;

// A collapsing building sinks and is replaced by its ruin rising out of the rubble.
const BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
#ifdef RUIN
transformed.y *= smoothstep(0.3, 0.9, bCollapse);
if (bCollapse < 0.32) transformed = vec3(0.0);
#else
transformed.y *= mix(1.0, 0.12, bCollapse);
if (bCollapse > 0.95) transformed = vec3(0.0);
#endif
`;

type Uniforms = { uMinute: { value: number }; uTime: { value: number } };

function buildingMaterial(uniforms: Uniforms, ruin: boolean): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ vertexColors: true });
    // Defines are part of three's program cache key, so the two kinds compile separately.
    if (ruin) material.defines = { RUIN: '' };
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${PARS}`)
            .replace('#include <color_vertex>', `#include <color_vertex>\n${COLOR}`)
            .replace('#include <begin_vertex>', BEGIN);
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying float vFireGlow;\nvarying float vEmber;',
            )
            .replace(
                '#include <emissivemap_fragment>',
                `#include <emissivemap_fragment>
                totalEmissiveRadiance += vec3(1.0, 0.34, 0.05) * vFireGlow * 0.7 + vec3(0.9, 0.18, 0.02) * vEmber * 0.12;`,
            );
    };
    return withVisibility(material);
}

type Item = { b: Building; rect: Rect; heightScale: number };

const ATTRIBUTES = [
    ['aFire', 'fire'],
    ['aRoof', 'roof'],
    ['aWall', 'wall'],
] as const;

/**
 * Every instance of one model. Each is drawn by `full` while it is near the camera and by `lod`
 * otherwise; `sort` deals the instances out between the two.
 */
class Batch {
    private readonly meshes: [InstancedMesh, InstancedMesh];
    private readonly matrix: Float32Array;
    private readonly fire: Float32Array;
    private readonly roof: Float32Array;
    private readonly wall: Float32Array;
    private readonly centres: Float32Array;

    constructor(scene: Scene, model: BuildingModel, material: MeshLambertMaterial, items: Item[]) {
        const count = items.length;
        this.matrix = new Float32Array(count * 16);
        this.fire = new Float32Array(count * 3);
        this.roof = new Float32Array(count * 3);
        this.wall = new Float32Array(count * 3);
        this.centres = new Float32Array(count * 2);
        const m = new Matrix4();
        const q = new Quaternion();
        const up = new Vector3(0, 1, 0);
        const pos = new Vector3();
        const scale = new Vector3();
        const c = new Color();
        const flat = model.kind === 'block';
        items.forEach(({ b, rect, heightScale }, k) => {
            q.setFromAxisAngle(up, rect.angleRad);
            pos.set(rect.cx, 0, -rect.cy);
            scale.set(rect.lengthM / model.lengthM, heightScale, rect.widthM / model.widthM);
            m.compose(pos, q, scale).toArray(this.matrix, k * 16);
            this.centres.set([rect.cx, -rect.cy], k * 2);
            this.fire.set([b.ignitionMin ?? NEVER, b.flameMin, b.destroyed ? 1 : 0], k * 3);
            c.setHex(nearestColour(flat ? DECKS : ROOFS, b.roofRgb)).toArray(this.roof, k * 3);
            const unit = hash(b.id, Math.round(rect.cx + rect.cy));
            c.setHex(WALLS[Math.floor(unit * WALLS.length)]!).toArray(this.wall, k * 3);
        });
        const mesh = (baked: BakedModel): InstancedMesh => {
            const out = new InstancedMesh(baked.geometry, material, count);
            out.instanceMatrix.setUsage(DynamicDrawUsage);
            for (const [name] of ATTRIBUTES) {
                const attribute = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
                out.geometry.setAttribute(name, attribute.setUsage(DynamicDrawUsage));
            }
            out.count = 0;
            // Instances come and go with the camera; the whole town is one bounding volume anyway.
            out.frustumCulled = false;
            scene.add(out);
            return out;
        };
        this.meshes = [mesh(model.full), mesh(model.lod)];
    }

    /** Instances within `NEAR_M` of (x, z) go to the full model, the rest to the far one. */
    sort(x: number, z: number): void {
        const counts = [0, 0];
        for (let i = 0; i < this.centres.length / 2; i++) {
            const dx = this.centres[i * 2]! - x;
            const dz = this.centres[i * 2 + 1]! - z;
            const level = dx * dx + dz * dz < NEAR_M * NEAR_M ? 0 : 1;
            const mesh = this.meshes[level]!;
            const n = counts[level]!++;
            mesh.instanceMatrix.array.set(this.matrix.subarray(i * 16, i * 16 + 16), n * 16);
            for (const [name, source] of ATTRIBUTES) {
                const target = mesh.geometry.getAttribute(name) as InstancedBufferAttribute;
                target.array.set(this[source].subarray(i * 3, i * 3 + 3), n * 3);
            }
        }
        this.meshes.forEach((mesh, level) => {
            mesh.count = counts[level]!;
            mesh.instanceMatrix.needsUpdate = true;
            for (const [name] of ATTRIBUTES) mesh.geometry.getAttribute(name).needsUpdate = true;
        });
    }
}

/**
 * Every pre-fire building as `assets/` models fitted to its footprint (`layout`), burning and
 * collapsing into a ruin model with the fire. Nothing is built here: a footprint no single model
 * fits is covered by several.
 */
export class Buildings {
    readonly uniforms: Uniforms = { uMinute: { value: 0 }, uTime: { value: 0 } };
    /** How many models stand in the town (a footprint may take several). */
    readonly count: number;
    private readonly batches: Batch[] = [];
    private sortedAt: Vector3 | null = null;

    constructor(scene: Scene, buildings: Building[], roads: Road[], models: BuildingModel[]) {
        const toRoad = roadFinder(roads);
        const items: Item[][] = models.map(() => []);
        let count = 0;
        for (const b of buildings)
            for (const p of layout(b, models, toRoad)) {
                items[p.model]!.push({ b, rect: p.rect, heightScale: p.heightScale });
                count++;
                if (b.destroyed)
                    items[ruinFor(models, p.rect, b.id)]!.push({ b, rect: p.rect, heightScale: 1 });
            }
        this.count = count;
        const standing = buildingMaterial(this.uniforms, false);
        const ruined = buildingMaterial(this.uniforms, true);
        models.forEach((model, k) => {
            if (!items[k]!.length) return;
            const material = model.kind === 'ruin' ? ruined : standing;
            this.batches.push(new Batch(scene, model, material, items[k]!));
        });
    }

    update(minute: number, timeS: number, camera: Vector3): void {
        this.uniforms.uMinute.value = minute;
        this.uniforms.uTime.value = timeS;
        if (this.sortedAt && this.sortedAt.distanceTo(camera) < REFRESH_M) return;
        this.sortedAt = (this.sortedAt ?? new Vector3()).copy(camera);
        for (const batch of this.batches) batch.sort(camera.x, camera.z);
    }
}
