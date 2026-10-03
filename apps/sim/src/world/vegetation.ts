import {
    Color,
    DoubleSide,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    MeshLambertMaterial,
    Quaternion,
    Vector3,
} from 'three';
import type { BufferGeometry, Scene } from 'three';
import { FORMS, TREE_FIELDS } from './assets';
import type { WorldAssets } from './assets';
import type { BakedModel, TreeModels } from './models';
import { withVisibility } from './visibility';

const F = Object.fromEntries(TREE_FIELDS.map((k, i) => [k, i])) as Record<
    (typeof TREE_FIELDS)[number],
    number
>;
const CHUNK_M = 400;
const LOD_NEAR_M = 350;
const DRAW_RANGE_M = 4500;
const MIN_FLAME_MIN = 15;

/** A model scaled to unit height and crown radius, so instances scale by the tree's own size. */
function unitTree(model: BakedModel): BufferGeometry {
    const { heightM, crownRadiusM } = model.size;
    if (!heightM || !crownRadiusM) throw new Error('tree model without heightM and crownRadiusM');
    return model.geometry.clone().scale(1 / crownRadiusM, 1 / heightM, 1 / crownRadiusM);
}

const PARS = /* glsl */ `
attribute float part; // 0 bark, 1 foliage
attribute vec4 aFire;
uniform float uMinute;
uniform float uTime;
varying float vFireGlow;
`;

// Burning crowns darken and glow; afterwards survivors are scorched and the rest lose their
// foliage, leaving the charred bark. aFire = (arrival_min, flame_min, survives, seed).
const COLOR = /* glsl */ `
float fSince = uMinute - aFire.x;
float fFlame = max(aFire.y, ${MIN_FLAME_MIN.toFixed(1)});
float fBurning = (fSince >= 0.0 && fSince < fFlame) ? 1.0 : 0.0;
float fBurned = fSince >= fFlame ? 1.0 : 0.0;
float fDead = fBurned * (1.0 - aFire.z);
float fX = clamp(fSince / fFlame, 0.0, 1.0);
vColor.rgb = color * mix(vec3(1.0), instanceColor.rgb, part);
vColor.rgb = mix(vColor.rgb, vColor.rgb * 0.2, fBurning * fX);
vColor.rgb = mix(vColor.rgb, vec3(0.16, 0.09, 0.035), fBurned * aFire.z * part * 0.7);
vColor.rgb = mix(vColor.rgb, vec3(0.025, 0.022, 0.02), fDead);
float flick = 0.65 + 0.35 * sin(uTime * 9.0 + aFire.w * 40.0 + position.y * 6.0);
vFireGlow = fBurning * part * smoothstep(0.0, 0.12, fX) * (1.0 - fX * 0.8) * flick;
`;

// Burnt-away foliage collapses to a point, so its triangles are not drawn.
const BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
if (part > 0.5) transformed *= 1.0 - fDead;
`;

function treeMaterial(uniforms: {
    uMinute: { value: number };
    uTime: { value: number };
}): MeshLambertMaterial {
    // Foliage is double-sided (assets/README.md).
    const material = new MeshLambertMaterial({ side: DoubleSide, vertexColors: true });
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${PARS}`)
            .replace('#include <color_vertex>', `#include <color_vertex>\n${COLOR}`)
            .replace('#include <begin_vertex>', BEGIN);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vFireGlow;')
            .replace(
                '#include <emissivemap_fragment>',
                '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.32, 0.05) * vFireGlow * 2.5;',
            );
    };
    return withVisibility(material);
}

/**
 * Every reconstructed tree as one of the two `assets/` variants of its growth form, instanced per
 * form, variant and 400 m chunk. Each chunk has a full and a `_lod1` mesh sharing its instances;
 * distance from the camera picks one, and chunks out of range are not drawn.
 */
export class Vegetation {
    readonly uniforms = { uMinute: { value: 0 }, uTime: { value: 0 } };
    readonly count: number;
    private readonly chunks: { full: InstancedMesh; lod: InstancedMesh }[] = [];

    constructor(scene: Scene, assets: WorldAssets, models: TreeModels) {
        const { trees, treeStride: S } = assets;
        this.count = trees.length / S;
        const material = treeMaterial(this.uniforms);
        const geometries = FORMS.map((form) => ({
            full: models[form].full.map(unitTree),
            lod: models[form].lod.map(unitTree),
        }));
        const buckets = new Map<string, number[]>();
        for (let i = 0; i < this.count; i++) {
            const o = i * S;
            const variant = (trees[o + F.seed]! * 3.17) % 1 < 0.5 ? 0 : 1;
            const cx = Math.floor(trees[o + F.x]! / CHUNK_M);
            const cy = Math.floor(trees[o + F.y]! / CHUNK_M);
            const key = `${trees[o + F.form]!}:${variant}:${cx}:${cy}`;
            let list = buckets.get(key);
            if (!list) buckets.set(key, (list = []));
            list.push(i);
        }
        const m = new Matrix4();
        const q = new Quaternion();
        const up = new Vector3(0, 1, 0);
        const pos = new Vector3();
        const scale = new Vector3();
        const colour = new Color();
        for (const [key, ids] of buckets) {
            const [form, variant] = key.split(':').map(Number) as [number, number];
            const g = geometries[form]!;
            const full = new InstancedMesh(g.full[variant]!.clone(), material, ids.length);
            const fire = new Float32Array(ids.length * 4);
            ids.forEach((i, k) => {
                const o = i * S;
                const r = trees[o + F.crown_radius_m]!;
                const seed = trees[o + F.seed]!;
                q.setFromAxisAngle(up, seed * Math.PI * 2);
                pos.set(trees[o + F.x]!, 0, -trees[o + F.y]!);
                scale.set(r, trees[o + F.height_m]!, r * (0.85 + 0.3 * ((seed * 7.31) % 1)));
                full.setMatrixAt(k, m.compose(pos, q, scale));
                // Seen from above, crowns in imagery include their own shadow; lift them a little.
                colour.setRGB(
                    Math.min(1, trees[o + F.r]! * 1.35),
                    Math.min(1, trees[o + F.g]! * 1.35),
                    Math.min(1, trees[o + F.b]! * 1.25),
                    'srgb',
                );
                full.setColorAt(k, colour);
                fire.set(
                    [
                        trees[o + F.arrival_min]!,
                        trees[o + F.flame_min]!,
                        trees[o + F.survives]!,
                        seed,
                    ],
                    k * 4,
                );
            });
            const aFire = new InstancedBufferAttribute(fire, 4);
            full.geometry.setAttribute('aFire', aFire);
            const lod = new InstancedMesh(g.lod[variant]!.clone(), material, ids.length);
            lod.geometry.setAttribute('aFire', aFire);
            lod.instanceMatrix = full.instanceMatrix;
            lod.instanceColor = full.instanceColor;
            full.computeBoundingSphere();
            lod.boundingSphere = full.boundingSphere;
            this.chunks.push({ full, lod });
            scene.add(full, lod);
        }
    }

    update(minute: number, timeS: number, camera: Vector3): void {
        this.uniforms.uMinute.value = minute;
        this.uniforms.uTime.value = timeS;
        for (const { full, lod } of this.chunks) {
            const s = full.boundingSphere;
            const d = s ? s.center.distanceTo(camera) - s.radius : 0;
            full.visible = d < LOD_NEAR_M;
            lod.visible = !full.visible && d < DRAW_RANGE_M;
        }
    }
}
