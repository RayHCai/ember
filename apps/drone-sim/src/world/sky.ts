import {
    BackSide,
    Color,
    DirectionalLight,
    HemisphereLight,
    Mesh,
    ShaderMaterial,
    SphereGeometry,
    Vector3,
} from 'three';
import type { Scene } from 'three';
import type { WorldFrame } from './frame';
import { daylight, sunPosition } from './sun';

export type Lighting = {
    /** Unit vector toward the sun, scene axes. */
    sunDir: Vector3;
    sunColor: Color;
    ambient: Color;
    /** 1 at night, 0 in full daylight. */
    dark: number;
    elevationDeg: number;
};

const srgb = (r: number, g: number, b: number): Color => new Color().setRGB(r, g, b, 'srgb');

const DAY_SKY = srgb(0.53, 0.75, 0.93);
const DAY_ZENITH = srgb(0.25, 0.47, 0.8);
const NIGHT_SKY = srgb(0.03, 0.05, 0.11);
const SMOKE_SKY = srgb(0.55, 0.52, 0.5);

const DOME_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Pinned just inside the far plane so the dome never clips, whatever the camera's range.
    gl_Position = p.xyww * vec4(1.0, 1.0, 0.99999, 1.0);
}`;

const DOME_FRAGMENT = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uDark;
uniform float uSmoke;
uniform float uTime;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
    return v;
}

void main() {
    vec3 d = normalize(vDir);
    float up = max(d.y, 0.0);
    vec3 col = mix(uHorizon, uZenith, pow(up, 0.5));
    float mu = max(dot(d, uSunDir), 0.0);
    float above = smoothstep(-0.02, 0.01, d.y);
    // Disc, then a broad warm glow that reddens the horizon around a low sun.
    col += uSunColor * (smoothstep(0.9995, 0.9998, mu) * 6.0 + pow(mu, 64.0) * 0.6 + pow(mu, 6.0) * 0.15) * above;

    // Clouds on a plane overhead, drifting with time, thinning toward the horizon.
    vec2 uv = d.xz / max(d.y, 0.04) * 0.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float c = smoothstep(0.48, 0.78, fbm(uv));
    float cloudLit = 0.75 + 0.25 * dot(normalize(vec3(d.x, 0.3, d.z)), uSunDir);
    vec3 cloudCol = mix(uHorizon * 1.15, vec3(1.0), 0.6) * cloudLit * (1.0 - 0.9 * uDark)
        + uSunColor * pow(mu, 8.0) * 0.4;
    col = mix(col, cloudCol, c * smoothstep(0.0, 0.25, d.y) * 0.85);

    if (uDark > 0.5) {
        float star = step(0.9985, hash(floor(d.xz / max(d.y, 0.1) * 300.0)));
        col += vec3(star) * smoothstep(0.6, 0.95, uDark) * smoothstep(0.05, 0.3, d.y) * (1.0 - c);
    }
    col = mix(col, uHorizon, uSmoke * 0.6);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
}`;

/**
 * Sun, sky light and sky colour for a scenario moment, following Demo Data's lighting (sunset
 * ~19:05 HST).
 */
export class Sky {
    readonly lighting: Lighting = {
        sunDir: new Vector3(0, 1, 0),
        sunColor: new Color(1, 1, 1),
        ambient: new Color(0.3, 0.3, 0.3),
        dark: 0,
        elevationDeg: 90,
    };
    private readonly sun = new DirectionalLight(0xffffff, 2.5);
    private readonly hemi = new HemisphereLight(0xbfd4ff, 0x4a4033, 1.0);
    private readonly background = DAY_SKY.clone();
    private readonly smoke = new Color();
    private readonly dome: Mesh<SphereGeometry, ShaderMaterial>;

    constructor(
        scene: Scene,
        private readonly frame: WorldFrame,
    ) {
        this.dome = new Mesh(
            new SphereGeometry(100, 32, 16),
            new ShaderMaterial({
                vertexShader: DOME_VERTEX,
                fragmentShader: DOME_FRAGMENT,
                side: BackSide,
                depthWrite: false,
                depthTest: false,
                uniforms: {
                    uSunDir: { value: this.lighting.sunDir },
                    uZenith: { value: new Color() },
                    uHorizon: { value: this.background },
                    uSunColor: { value: new Color() },
                    uDark: { value: 0 },
                    uSmoke: { value: 0 },
                    uTime: { value: 0 },
                },
            }),
        );
        this.dome.frustumCulled = false;
        this.dome.renderOrder = -1e9;
        // Centred on whichever camera draws it: the orbit view and the drone's sight alike.
        this.dome.onBeforeRender = (_r, _s, camera) => {
            this.dome.position.setFromMatrixPosition(camera.matrixWorld);
            this.dome.updateMatrixWorld();
        };
        scene.add(this.sun, this.sun.target, this.hemi, this.dome);
        scene.background = this.background;
    }

    /** `smokiness` 0..1 dims the sun while the town burns. */
    update(timeMs: number, cameraPosition: Vector3, smokiness: number): void {
        const { elevationDeg, azimuthDeg } = sunPosition(this.frame.lat0, this.frame.lng0, timeMs);
        const light = daylight(elevationDeg);
        const el = (Math.max(elevationDeg, -4) * Math.PI) / 180;
        const az = (azimuthDeg * Math.PI) / 180;
        const dir = new Vector3(
            Math.sin(az) * Math.cos(el),
            Math.sin(el),
            -Math.cos(az) * Math.cos(el),
        ).normalize();

        let tint: [number, number, number] = [1, 1, 1];
        if (elevationDeg < -6) tint = [0.72, 0.84, 1.15];
        else if (elevationDeg < 8) {
            const w = (elevationDeg + 6) / 14;
            tint = [0.9 * (1 - w) + 1.08 * w, 0.85 * (1 - w) + 0.93 * w, 1.0 * (1 - w) + 0.8 * w];
        }
        const s = Math.min(Math.max(smokiness, 0), 1);
        const L = this.lighting;
        L.sunDir.copy(dir);
        L.elevationDeg = elevationDeg;
        L.dark = 1 - light;
        const sunUp = Math.max(0, Math.min(1, (elevationDeg + 2) / 8));
        L.sunColor
            .copy(srgb(tint[0], tint[1], tint[2]))
            .multiplyScalar(2.2 * light * sunUp * (1 - 0.45 * s));
        L.ambient
            .copy(srgb(0.55 * tint[0], 0.6 * tint[1], 0.7 * tint[2]))
            .multiplyScalar(0.55 * light + 0.04);

        this.sun.position.copy(dir).multiplyScalar(5000).add(cameraPosition);
        this.sun.target.position.copy(cameraPosition);
        this.sun.color.copy(L.sunColor);
        this.sun.intensity = 1.4;
        this.hemi.color.copy(L.ambient);
        this.hemi.groundColor.copy(L.ambient).multiplyScalar(0.5);
        this.hemi.intensity = 2.0;
        this.background
            .copy(NIGHT_SKY)
            .lerp(DAY_SKY, light)
            .lerp(this.smoke.copy(SMOKE_SKY).multiplyScalar(0.15 + 0.85 * light), 0.5 * s);
        const u = this.dome.material.uniforms;
        (u.uZenith!.value as Color)
            .copy(NIGHT_SKY)
            .lerp(DAY_ZENITH, light)
            .lerp(this.smoke, 0.5 * s);
        (u.uSunColor!.value as Color)
            .copy(srgb(tint[0], tint[1] * 0.9, tint[2] * 0.75))
            .multiplyScalar(sunUp * (1 - 0.6 * s));
        u.uDark!.value = L.dark;
        u.uSmoke!.value = s;
        // Epoch seconds overflow float precision in the shader; a day wrap keeps drift smooth.
        u.uTime!.value = (timeMs / 1000) % 86_400;
    }
}
