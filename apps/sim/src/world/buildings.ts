import {
    BufferAttribute,
    BufferGeometry,
    Color,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshLambertMaterial,
    Quaternion,
    ShapeUtils,
    Vector2,
    Vector3,
} from 'three';
import type { Scene } from 'three';
import type { Building } from './assets';
import type { BakedModel, BuildingKind } from './models';
import { withVisibility } from './visibility';

const NEVER = 1.0e6;
const STRUCTURE_SMOULDER_MIN = 1080;

class GeometryBuilder {
    readonly position: number[] = [];
    readonly normal: number[] = [];
    readonly color: number[] = [];
    readonly fire: number[] = [];

    constructor(private readonly fireInfo: () => [number, number, number]) {}

    /** Triangle from world (x, y, h) points; the normal follows the winding (counter-clockwise = front). */
    tri(a: number[], b: number[], c: number[], col: Color): void {
        const [ax, ay, ah] = a as [number, number, number];
        const [bx, by, bh] = b as [number, number, number];
        const [cx, cy, ch] = c as [number, number, number];
        // Scene axes: X = x, Y = h, Z = -y.
        const ux = bx - ax,
            uy = bh - ah,
            uz = -(by - ay);
        const vx = cx - ax,
            vy = ch - ah,
            vz = -(cy - ay);
        let nx = uy * vz - uz * vy,
            ny = uz * vx - ux * vz,
            nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        const f = this.fireInfo();
        for (const [x, y, h] of [a, b, c] as [number, number, number][]) {
            this.position.push(x, h, -y);
            this.normal.push(nx, ny, nz);
            this.color.push(col.r, col.g, col.b);
            this.fire.push(...f);
        }
    }

    quad(a: number[], b: number[], c: number[], d: number[], col: Color): void {
        this.tri(a, b, c, col);
        this.tri(a, c, d, col);
    }

    build(): BufferGeometry {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
        g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
        g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
        g.setAttribute('aFire', new BufferAttribute(new Float32Array(this.fire), 3));
        g.computeBoundingSphere();
        return g;
    }
}

function addBuilding(gb: GeometryBuilder, b: Building): void {
    let ring = b.footprint.map(([x, y]) => new Vector2(x, y));
    if (ShapeUtils.isClockWise(ring)) ring = ring.toReversed();
    const h = b.heightM;
    const roof = new Color().setRGB(b.roofRgb[0], b.roofRgb[1], b.roofRgb[2], 'srgb');
    const wall = wallColour(b);
    // Counter-clockwise footprint: the wall's outward side is on the right of each edge.
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        gb.quad([p.x, p.y, 0], [q.x, q.y, 0], [q.x, q.y, h], [p.x, p.y, h], wall);
    }
    if (b.roof === 'gable' && b.gable) {
        const { cx, cy, lengthM, widthM, angleRad } = b.gable;
        const ux = Math.cos(angleRad),
            uy = Math.sin(angleRad);
        const vx = -uy,
            vy = ux;
        const L = lengthM / 2 + 0.3,
            W = widthM / 2 + 0.3;
        const ridge = h + 0.32 * widthM;
        const corner = (s: number, t: number, z: number): number[] => [
            cx + ux * L * s + vx * W * t,
            cy + uy * L * s + vy * W * t,
            z,
        ];
        const r0 = [cx - ux * L, cy - uy * L, ridge];
        const r1 = [cx + ux * L, cy + uy * L, ridge];
        gb.quad(corner(-1, -1, h), corner(1, -1, h), r1, r0, roof);
        gb.quad(corner(1, 1, h), corner(-1, 1, h), r0, r1, roof);
        gb.tri(corner(1, -1, h), corner(1, 1, h), r1, wall);
        gb.tri(corner(-1, 1, h), corner(-1, -1, h), r0, wall);
        // Underside of the eaves would show through from oblique views; the roof is closed instead.
        gb.quad(corner(-1, -1, h), corner(-1, 1, h), corner(1, 1, h), corner(1, -1, h), roof);
    } else {
        const tris = ShapeUtils.triangulateShape(ring, []);
        for (const [a, b2, c] of tris) {
            const pa = ring[a!]!,
                pb = ring[b2!]!,
                pc = ring[c!]!;
            gb.tri([pa.x, pa.y, h], [pb.x, pb.y, h], [pc.x, pc.y, h], roof);
        }
    }
}

/** An oriented rectangle in the world frame; `angleRad` is the direction of its long side. */
export type Rect = { cx: number; cy: number; lengthM: number; widthM: number; angleRad: number };

export type Placement = { kind: BuildingKind; rect: Rect };

/** The wall footprint a building model was made with (`lengthM` along its X). */
export type ModelFootprint = { lengthM: number; widthM: number };

/** A model stands in for a rectangle only if it covers it without much distortion. */
const MAX_STRETCH = 1.35;
const SCALE_RANGE: [number, number] = [0.5, 2.2];
const SHOP_MIN_FILL = 0.85;

/** How far a model's proportions change to cover a rectangle (1: not at all), or Infinity when it would have to shrink or grow too much. */
export function stretch(rect: Rect, model: ModelFootprint): number {
    const sx = rect.lengthM / model.lengthM;
    const sz = rect.widthM / model.widthM;
    if (Math.min(sx, sz) < SCALE_RANGE[0] || Math.max(sx, sz) > SCALE_RANGE[1]) return Infinity;
    return Math.max(sx / sz, sz / sx);
}

/** Smallest rectangle around a footprint, and how much of it the footprint fills. */
export function minAreaRect(points: [number, number][]): Rect & { fill: number } {
    let best: (Rect & { area: number }) | null = null;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]!;
        const [bx, by] = points[(i + 1) % points.length]!;
        const a = Math.atan2(by - ay, bx - ax);
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        let s0 = Infinity;
        let s1 = -Infinity;
        let t0 = Infinity;
        let t1 = -Infinity;
        for (const [x, y] of points) {
            const s = x * ux + y * uy;
            const t = -x * uy + y * ux;
            s0 = Math.min(s0, s);
            s1 = Math.max(s1, s);
            t0 = Math.min(t0, t);
            t1 = Math.max(t1, t);
        }
        const area = (s1 - s0) * (t1 - t0);
        if (best && area >= best.area) continue;
        const sc = (s0 + s1) / 2;
        const tc = (t0 + t1) / 2;
        const long = s1 - s0 >= t1 - t0;
        best = {
            cx: sc * ux - tc * uy,
            cy: sc * uy + tc * ux,
            lengthM: long ? s1 - s0 : t1 - t0,
            widthM: long ? t1 - t0 : s1 - s0,
            angleRad: long ? a : a + Math.PI / 2,
            area,
        };
    }
    if (!best || best.area <= 0)
        return { cx: 0, cy: 0, lengthM: 0, widthM: 0, angleRad: 0, fill: 0 };
    const polygon = Math.abs(ShapeUtils.area(points.map(([x, y]) => new Vector2(x, y))));
    const { area, ...rect } = best;
    return { ...rect, fill: polygon / area };
}

/**
 * Which `assets/` model stands in for a footprint, or null to extrude it. Demo Data's gable
 * footprints (near-rectangular, under 450 m²) take whichever house model fits them better; flat
 * roofs that are close to rectangular take the shop. A model is used only if it fits without much
 * stretching (`stretch`); long rows, sheds, big halls and irregular outlines are extruded exactly.
 */
export function placement(
    b: Building,
    models: Record<BuildingKind, ModelFootprint>,
): Placement | null {
    if (b.roof === 'gable' && b.gable) {
        const rect = b.gable;
        const kind =
            stretch(rect, models.house_hip) <= stretch(rect, models.house_gable)
                ? 'house_hip'
                : 'house_gable';
        return stretch(rect, models[kind]) <= MAX_STRETCH ? { kind, rect } : null;
    }
    if (b.footprint.length < 3) return null;
    const { fill, ...rect } = minAreaRect(b.footprint);
    return fill >= SHOP_MIN_FILL && stretch(rect, models.shop) <= MAX_STRETCH
        ? { kind: 'shop', rect }
        : null;
}

function wallColour(b: Building): Color {
    const seed = Math.sin(b.id * 12.9898) * 43758.5453;
    const shade = 0.82 + 0.18 * (seed - Math.floor(seed));
    return new Color().setRGB(0.8 * shade, 0.77 * shade, 0.7 * shade, 'srgb');
}

const PARS = /* glsl */ `
attribute vec3 aFire;
#ifdef MODEL
attribute float part; // 0 as modelled, 1 roof, 2 wall
attribute vec3 aRoof;
attribute vec3 aWall;
#endif
uniform float uMinute;
uniform float uTime;
varying float vFireGlow;
varying float vEmber;
`;

// aFire = (ignition_min, flame_min, destroyed). Destroyed buildings burn, then collapse to
// charred rubble (the ruin model for modelled ones) that keeps smouldering; survivors stand.
const COLOR = /* glsl */ `
float bSince = uMinute - aFire.x;
float bBurning = (bSince >= 0.0 && bSince < aFire.y) ? 1.0 : 0.0;
float bCollapse = aFire.z * smoothstep(0.35 * aFire.y, aFire.y, bSince);
#ifdef MODEL
vColor.rgb = color * (part > 1.5 ? aWall : part > 0.5 ? aRoof : vec3(1.0));
#endif
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

// Collapsing buildings sink; a modelled one is replaced by its ruin rising out of the rubble.
const BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
#ifdef RUIN
transformed.y *= smoothstep(0.3, 0.9, bCollapse);
if (bCollapse < 0.32) transformed = vec3(0.0);
#else
transformed.y *= mix(1.0, 0.12, bCollapse);
#ifdef MODEL
if (bCollapse > 0.95) transformed = vec3(0.0);
#endif
#endif
`;

type Uniforms = { uMinute: { value: number }; uTime: { value: number } };

function buildingMaterial(
    uniforms: Uniforms,
    kind: 'extruded' | 'model' | 'ruin',
): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ vertexColors: true });
    // Defines are part of three's program cache key, so the three kinds compile separately.
    if (kind === 'model') material.defines = { MODEL: '' };
    if (kind === 'ruin') material.defines = { MODEL: '', RUIN: '' };
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

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Instanced copies of one model fitted to footprint rectangles, with per-building colour and fire. */
function instances(
    model: BakedModel,
    material: MeshLambertMaterial,
    items: { b: Building; rect: Rect; heightScale: number }[],
): InstancedMesh {
    const { lengthM, widthM } = model.size;
    if (!lengthM || !widthM) throw new Error('building model without lengthM and widthM');
    const mesh = new InstancedMesh(model.geometry.clone(), material, items.length);
    const fire = new Float32Array(items.length * 3);
    const roof = new Float32Array(items.length * 3);
    const wall = new Float32Array(items.length * 3);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scale = new Vector3();
    const c = new Color();
    items.forEach(({ b, rect, heightScale }, k) => {
        // Front (+Z) faces one long side or the other; the street side is not known.
        const flip = Math.sin(b.id * 78.233) > 0 ? Math.PI : 0;
        q.setFromAxisAngle(up, rect.angleRad + flip);
        pos.set(rect.cx, 0, -rect.cy);
        scale.set(rect.lengthM / lengthM, heightScale, rect.widthM / widthM);
        mesh.setMatrixAt(k, m.compose(pos, q, scale));
        fire.set([b.ignitionMin ?? NEVER, b.flameMin, b.destroyed ? 1 : 0], k * 3);
        c.setRGB(b.roofRgb[0], b.roofRgb[1], b.roofRgb[2], 'srgb');
        roof.set([c.r, c.g, c.b], k * 3);
        c.copy(wallColour(b));
        wall.set([c.r, c.g, c.b], k * 3);
    });
    mesh.geometry.setAttribute('aFire', new InstancedBufferAttribute(fire, 3));
    mesh.geometry.setAttribute('aRoof', new InstancedBufferAttribute(roof, 3));
    mesh.geometry.setAttribute('aWall', new InstancedBufferAttribute(wall, 3));
    mesh.computeBoundingSphere();
    return mesh;
}

/**
 * Every pre-fire building, burning and collapsing with the fire model: houses and shops as
 * `assets/` models fitted to their footprint (see `placement`), the rest extruded from their
 * outline into one merged mesh.
 */
export class Buildings {
    readonly uniforms: Uniforms = { uMinute: { value: 0 }, uTime: { value: 0 } };

    constructor(
        scene: Scene,
        buildings: Building[],
        models: Record<BuildingKind | 'ruin', BakedModel>,
    ) {
        let current: [number, number, number] = [NEVER, 0, 0];
        const gb = new GeometryBuilder(() => current);
        const placed: Record<BuildingKind, { b: Building; rect: Rect; heightScale: number }[]> = {
            house_gable: [],
            house_hip: [],
            shop: [],
        };
        const ruins: { b: Building; rect: Rect; heightScale: number }[] = [];
        const footprint = (kind: BuildingKind): ModelFootprint => {
            const { lengthM, widthM } = models[kind].size;
            if (!lengthM || !widthM) throw new Error(`${kind} model without lengthM and widthM`);
            return { lengthM, widthM };
        };
        const footprints = {
            house_gable: footprint('house_gable'),
            house_hip: footprint('house_hip'),
            shop: footprint('shop'),
        };
        for (const b of buildings) {
            const p = placement(b, footprints);
            if (!p) {
                current = [b.ignitionMin ?? NEVER, b.flameMin, b.destroyed ? 1 : 0];
                addBuilding(gb, b);
                continue;
            }
            const size = models[p.kind].size;
            const modelHeight = size.eaveHeightM ?? size.heightM ?? b.heightM;
            placed[p.kind].push({
                b,
                rect: p.rect,
                heightScale: clamp(b.heightM / modelHeight, 0.7, 1.8),
            });
            if (b.destroyed) ruins.push({ b, rect: p.rect, heightScale: 1 });
        }
        scene.add(new Mesh(gb.build(), buildingMaterial(this.uniforms, 'extruded')));
        const model = buildingMaterial(this.uniforms, 'model');
        for (const kind of ['house_gable', 'house_hip', 'shop'] as const) {
            if (placed[kind].length) scene.add(instances(models[kind], model, placed[kind]));
        }
        if (ruins.length)
            scene.add(instances(models.ruin, buildingMaterial(this.uniforms, 'ruin'), ruins));
    }

    update(minute: number, timeS: number): void {
        this.uniforms.uMinute.value = minute;
        this.uniforms.uTime.value = timeS;
    }
}
