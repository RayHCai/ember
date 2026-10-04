import {
    CanvasTexture,
    Color,
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    NearestFilter,
    RedFormat,
    RGBAFormat,
    ShaderMaterial,
    Vector2,
    Vector3,
    Vector4,
} from 'three';
import type { Scene } from 'three';
import type { Road, WorldAssets } from './assets';
import type { FireField } from './fireField';
import type { Extent } from './frame';
import type { BakedModel } from './models';
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

// Ground rebuilt from Demo Data's fuel classes (see FUELS in model/build.py) and roads, as flat
// facets; no imagery. Fire compositing follows render/compositor.py: char behind the front, flames on it.
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
    if (k < 0.5) return lin(vec3(0.72, 0.69, 0.60));
    if (k < 1.5) return lin(vec3(0.60, 0.67, 0.35));
    if (k < 2.5) return lin(vec3(0.47, 0.59, 0.31));
    if (k < 3.5) return lin(vec3(0.35, 0.51, 0.27));
    if (k < 4.5) return lin(vec3(0.71, 0.69, 0.64));
    if (k < 5.5) return lin(vec3(0.67, 0.65, 0.61));
    if (k < 6.5) return lin(vec3(0.79, 0.71, 0.53));
    return lin(vec3(0.17, 0.45, 0.62));
}
float fuelAt(vec2 cell) {
    vec2 c = clamp(cell, vec2(0.0), uGrid - 1.0);
    return floor(texture2D(uFuel, (c + 0.5) / uGrid).r * 255.0 + 0.5);
}
// The ground is drawn as flat facets like the models standing on it: a mosaic of triangles
// size metres across. Returns the centre of the triangle under xy and its own random tone.
vec3 facet(vec2 xy, float size) {
    vec2 s = vec2(xy.x - xy.y * 0.57735, xy.y * 1.1547) / size;
    vec2 i = floor(s);
    vec2 f = fract(s);
    float upper = step(1.0, f.x + f.y);
    vec2 c = i + mix(vec2(1.0 / 3.0), vec2(2.0 / 3.0), upper);
    return vec3(vec2(c.x + c.y * 0.5, c.y * 0.8660254) * size, hash12(i + upper * 17.0));
}

void main() {
    vec2 xy = vec2(vWorld.x, -vWorld.z);
    vec3 tile = facet(xy, 7.0);
    vec2 fuv = (tile.xy - uFireExtent.xy) / (uFireExtent.zw - uFireExtent.xy);
    bool onGrid = all(greaterThanEqual(fuv, vec2(0.0))) && all(lessThanEqual(fuv, vec2(1.0)));

    // Beyond the grid: the sea to the west, open ground elsewhere.
    float k = onGrid ? fuelAt(floor(fuv * uGrid)) : (fuv.x < 0.0 ? 7.0 : 0.0);
    float water = float(k > 6.5);
    float debris = float(k > 3.5 && k < 5.5);
    if (water > 0.5) tile = facet(xy + 3.0 * sin(uTime * 0.2 + xy.yx * 0.02), 16.0);
    vec3 base = cover(k) * (0.9 + 0.2 * tile.z);

    vec2 ruv = (xy - uRoadExtent.xy) / (uRoadExtent.zw - uRoadExtent.xy);
    float paved = texture2D(uRoads, ruv).r * (1.0 - water);
    float road = smoothstep(0.4, 0.6, paved);
    float kerb = smoothstep(0.12, 0.3, paved) - road;

    vec4 f = onGrid ? texture2D(uFire, fuv) : vec4(0.0);
    float inten = f.r;
    float smoulder = f.g * 0.6;
    float burnt = f.b;
    float glow = f.a;

    vec3 charCol = lin(vec3(0.11, 0.10, 0.09)) * (0.7 + 0.6 * tile.z);
    vec3 ash = lin(vec3(0.42, 0.40, 0.37));
    base = mix(base, mix(charCol, ash, 0.45 * debris), burnt);
    base = mix(base, lin(vec3(0.80, 0.78, 0.73)), kerb * (1.0 - 0.6 * burnt));
    base = mix(base, lin(vec3(0.30, 0.31, 0.33)), road * (1.0 - 0.4 * burnt));

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
    gl_FragColor.rgb = emberShade(gl_FragColor.rgb, vWorld);
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

const HORIZON_M = 60000;

/**
 * Flat ground coloured by land cover, with roads, char and flames composited per frame: the
 * `assets/` ground square, stretched over the world and painted by this shader.
 */
export class Ground {
    readonly fireTexture: DataTexture;
    private readonly material: ShaderMaterial;

    constructor(scene: Scene, assets: WorldAssets, fire: FireField, model: BakedModel) {
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

        const { sizeM } = model.size;
        if (!sizeM) throw new Error('ground model without sizeM');
        const e = assets.extent;
        const inner = new Mesh(model.geometry, this.material);
        inner.scale.set((e.maxX - e.minX) / sizeM, 1, (e.maxY - e.minY) / sizeM);
        inner.position.set((e.minX + e.maxX) / 2, 0, -(e.minY + e.maxY) / 2);
        // Ground to the horizon around the data, so oblique views never end in a void. It lies
        // just under the first square, which covers it where the two overlap.
        const outer = new Mesh(model.geometry, this.material);
        outer.scale.set(HORIZON_M / sizeM, 1, HORIZON_M / sizeM);
        outer.position.y = -0.4;
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
