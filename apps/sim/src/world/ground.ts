import {
    CanvasTexture,
    Color,
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    NearestFilter,
    PlaneGeometry,
    RedFormat,
    RGBAFormat,
    ShaderMaterial,
    Shape,
    ShapeGeometry,
    Vector2,
    Vector3,
    Vector4,
} from 'three';
import type { Scene } from 'three';
import type { Road, WorldAssets } from './assets';
import type { FireField } from './fireField';
import type { Extent } from './frame';
import type { Lighting } from './sky';
import { VIS_PARS, VIS_UNIFORMS } from './visibility';

const ROAD_RES_M = 2;
const ROAD_MAX_PX = 4096;

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Ground rebuilt from Demo Data's fuel classes (see FUELS in model/build.py) and roads; no
// imagery. Fire compositing follows render/compositor.py: char behind the front, flames on it.
const FRAG = /* glsl */ `
uniform sampler2D uFuel;
uniform sampler2D uFire;
uniform sampler2D uRoads;
uniform vec4 uFireExtent;
uniform vec4 uRoadExtent;
uniform vec2 uGrid;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uDark;
uniform float uTime;
varying vec3 vWorld;
${VIS_PARS}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }

// none, grass, shrub, tree, urban, structure, bare, water
vec3 cover(float k) {
    if (k < 0.5) return lin(vec3(0.46, 0.43, 0.37));
    if (k < 1.5) return lin(vec3(0.50, 0.49, 0.30));
    if (k < 2.5) return lin(vec3(0.38, 0.43, 0.26));
    if (k < 3.5) return lin(vec3(0.26, 0.36, 0.20));
    if (k < 4.5) return lin(vec3(0.44, 0.43, 0.40));
    if (k < 5.5) return lin(vec3(0.40, 0.39, 0.37));
    if (k < 6.5) return lin(vec3(0.54, 0.48, 0.38));
    return lin(vec3(0.16, 0.33, 0.45));
}
float fuelAt(vec2 cell) {
    vec2 c = clamp(cell, vec2(0.0), uGrid - 1.0);
    return floor(texture2D(uFuel, (c + 0.5) / uGrid).r * 255.0 + 0.5);
}

void main() {
    float vis = emberVisible(vWorld);
    if (vis < 0.5) {
        gl_FragColor = vec4(1.0);
        return;
    }
    vec2 xy = vec2(vWorld.x, -vWorld.z);
    vec2 fuv = (xy - uFireExtent.xy) / (uFireExtent.zw - uFireExtent.xy);
    bool onGrid = all(greaterThanEqual(fuv, vec2(0.0))) && all(lessThanEqual(fuv, vec2(1.0)));

    // Blend the four nearest 10 m cells, with a noisy, sharpened weight so class edges wander.
    vec2 g = fuv * uGrid - 0.5 + (vec2(vnoise(xy / 6.0), vnoise(xy / 6.0 + 17.0)) - 0.5) * 0.9;
    vec2 c0 = floor(g);
    vec2 w = smoothstep(0.25, 0.75, fract(g));
    float k00 = fuelAt(c0);
    float k10 = fuelAt(c0 + vec2(1.0, 0.0));
    float k01 = fuelAt(c0 + vec2(0.0, 1.0));
    float k11 = fuelAt(c0 + vec2(1.0, 1.0));
    vec3 base = mix(mix(cover(k00), cover(k10), w.x), mix(cover(k01), cover(k11), w.x), w.y);
    float water = mix(mix(float(k00 > 6.5), float(k10 > 6.5), w.x), mix(float(k01 > 6.5), float(k11 > 6.5), w.x), w.y);
    float debris = mix(mix(float(k00 > 3.5 && k00 < 5.5), float(k10 > 3.5 && k10 < 5.5), w.x),
                       mix(float(k01 > 3.5 && k01 < 5.5), float(k11 > 3.5 && k11 < 5.5), w.x), w.y);
    if (!onGrid) {
        // Beyond the grid: the sea to the west, open ground elsewhere.
        water = fuv.x < 0.0 ? 1.0 : 0.0;
        debris = 0.0;
        base = cover(water > 0.5 ? 7.0 : 0.0);
    }
    base *= 0.88 + 0.24 * vnoise(xy / 9.0) + 0.08 * (vnoise(xy / 1.7) - 0.5);

    vec2 ruv = (xy - uRoadExtent.xy) / (uRoadExtent.zw - uRoadExtent.xy);
    float road = texture2D(uRoads, ruv).r * (1.0 - water);

    vec4 f = onGrid ? texture2D(uFire, fuv) : vec4(0.0);
    float inten = f.r;
    float smoulder = f.g * 0.6;
    float burnt = f.b;
    float glow = f.a;

    vec3 charCol = lin(vec3(0.11, 0.10, 0.09)) * (0.7 + 0.6 * vnoise(xy / 4.0));
    vec3 ash = lin(vec3(0.42, 0.40, 0.37));
    base = mix(base, mix(charCol, ash, 0.45 * debris), burnt);
    base = mix(base, lin(vec3(0.20, 0.20, 0.21)) * (0.9 + 0.2 * vnoise(xy / 3.0)), road * (1.0 - 0.4 * burnt));

    float ndl = max(uSunDir.y, 0.0);
    vec3 col = base * (uSunColor * ndl + uAmbient);
    col += base * lin(vec3(1.0, 0.5, 0.18)) * glow * (0.25 + 1.4 * uDark);

    if (water > 0.5) {
        vec2 wv = vec2(vnoise(xy / 7.0 + uTime * 0.25), vnoise(xy / 6.0 - uTime * 0.2)) - 0.5;
        vec3 n = normalize(vec3(wv.x * 0.25, 1.0, wv.y * 0.25));
        vec3 v = normalize(cameraPosition - vWorld);
        float spec = pow(max(dot(reflect(-uSunDir, n), v), 0.0), 120.0);
        col += uSunColor * spec * 0.6 * (1.0 - smoothstep(0.0, 0.4, uDark));
    }

    float n1 = vnoise(xy / 3.0 + vec2(uTime * 0.9, uTime * 0.4));
    float n2 = vnoise(xy / 0.9 + vec2(-uTime * 2.1, uTime * 1.7));
    float fl = inten * (0.2 + 1.2 * n1) + 0.3 * (n2 - 0.5);
    float flameA = smoothstep(0.30, 0.55, fl) * step(0.005, inten);
    float core = smoothstep(0.62, 0.95, fl) * flameA;
    vec3 flameCol = mix(lin(vec3(0.55, 0.06, 0.02)), lin(vec3(1.0, 0.42, 0.06)), clamp(flameA * 1.4, 0.0, 1.0));
    flameCol = mix(flameCol, lin(vec3(1.0, 0.92, 0.62)), core);
    float soot = clamp(inten * 1.4 * (1.0 - n1), 0.0, 0.7) * (1.0 - flameA);
    col = mix(col, lin(vec3(0.07, 0.06, 0.055)) * (uAmbient + uSunColor * ndl), soot);
    col = col * (1.0 - flameA) + flameCol * 1.6 * flameA;
    // Embers concentrate in building debris; open ground cools quickly.
    float ember = smoulder * (0.15 + 1.5 * vnoise(xy / 1.2 + 31.0)) * (0.2 + 0.8 * debris);
    col += lin(vec3(1.0, 0.28, 0.04)) * pow(clamp(ember, 0.0, 1.2), 1.2) * (0.2 + 2.0 * uDark);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

const vec4Of = (e: Extent): Vector4 => new Vector4(e.minX, e.minY, e.maxX, e.maxY);

/** Roads rasterised once over the world extent: red channel = paved coverage. */
function roadTexture(roads: Road[], e: Extent): CanvasTexture {
    const scale = Math.min(
        1 / ROAD_RES_M,
        ROAD_MAX_PX / (e.maxX - e.minX),
        ROAD_MAX_PX / (e.maxY - e.minY),
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((e.maxX - e.minX) * scale);
    canvas.height = Math.ceil((e.maxY - e.minY) * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of roads) {
        ctx.lineWidth = r.widthM * scale;
        ctx.beginPath();
        r.points.forEach(([x, y], i) => {
            const px = (x - e.minX) * scale;
            const py = (e.maxY - y) * scale;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        });
        ctx.stroke();
    }
    const texture = new CanvasTexture(canvas);
    texture.minFilter = LinearMipmapLinearFilter;
    texture.anisotropy = 8;
    return texture;
}

/** Flat ground coloured by land cover, with roads, char and flames composited per frame. */
export class Ground {
    readonly fireTexture: DataTexture;
    private readonly material: ShaderMaterial;

    constructor(scene: Scene, assets: WorldAssets, fire: FireField) {
        const { width, height } = assets.fire;
        this.fireTexture = new DataTexture(fire.texture, width, height, RGBAFormat);
        this.fireTexture.magFilter = LinearFilter;
        this.fireTexture.minFilter = LinearFilter;
        this.fireTexture.needsUpdate = true;
        const fuel = new DataTexture(new Uint8Array(assets.fire.fuel), width, height, RedFormat);
        fuel.magFilter = NearestFilter;
        fuel.minFilter = NearestFilter;
        fuel.unpackAlignment = 1;
        fuel.needsUpdate = true;

        this.material = new ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: {
                ...VIS_UNIFORMS,
                uFuel: { value: fuel },
                uFire: { value: this.fireTexture },
                uRoads: { value: roadTexture(assets.roads, assets.extent) },
                uFireExtent: { value: vec4Of(assets.fire.extent) },
                uRoadExtent: { value: vec4Of(assets.extent) },
                uGrid: { value: new Vector2(width, height) },
                uSunDir: { value: new Vector3(0, 1, 0) },
                uSunColor: { value: new Color(1, 1, 1) },
                uAmbient: { value: new Color(0.3, 0.3, 0.3) },
                uDark: { value: 0 },
                uTime: { value: 0 },
            },
        });

        const e = assets.extent;
        const inner = new Mesh(new PlaneGeometry(e.maxX - e.minX, e.maxY - e.minY), this.material);
        inner.rotation.x = -Math.PI / 2;
        inner.position.set((e.minX + e.maxX) / 2, 0, -(e.minY + e.maxY) / 2);
        // Ground to the horizon around the data, so oblique views never end in a void.
        const skirt = new Shape();
        const R = 30000;
        skirt.moveTo(-R, -R).lineTo(R, -R).lineTo(R, R).lineTo(-R, R).lineTo(-R, -R);
        const hole = new Shape();
        hole.moveTo(e.minX, e.minY)
            .lineTo(e.minX, e.maxY)
            .lineTo(e.maxX, e.maxY)
            .lineTo(e.maxX, e.minY);
        skirt.holes.push(hole);
        const outer = new Mesh(new ShapeGeometry(skirt), this.material);
        outer.rotation.x = -Math.PI / 2;
        scene.add(inner, outer);
    }

    update(lighting: Lighting, timeS: number, fireChanged: boolean): void {
        const u = this.material.uniforms;
        u.uSunDir!.value = lighting.sunDir;
        u.uSunColor!.value = lighting.sunColor;
        u.uAmbient!.value = lighting.ambient;
        u.uDark!.value = lighting.dark;
        u.uTime!.value = timeS;
        if (fireChanged) this.fireTexture.needsUpdate = true;
    }
}
