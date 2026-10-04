import {
    DataTexture,
    DepthTexture,
    Matrix4,
    PerspectiveCamera,
    RGBAFormat,
    UnsignedIntType,
    Vector2,
    WebGLRenderTarget,
} from 'three';
import type { Material, Scene, Texture, WebGLRenderer } from 'three';

/** Scene layers: the drone camera renders only `WORLD`, so effects never occlude and the drone model never hides its own view. */
export const LAYER = { WORLD: 0, EFFECTS: 1, DRONE: 2 } as const;

const DEPTH_SIZE = 1024;
/** Brightness left on what the drone cannot see (display colour, after tone mapping). */
const UNSEEN_SHADE = 0.38;

// The depth texture may not be bound while it is being rendered into.
const placeholder = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
placeholder.needsUpdate = true;

/** Shared by every world material, so one depth pass per frame drives them all. */
export const VIS_UNIFORMS = {
    uVisOn: { value: 0 },
    uVisMatrix: { value: new Matrix4() },
    uVisDepth: { value: placeholder as Texture },
    uVisNearFar: { value: new Vector2(1, 8000) },
};

/**
 * `emberVisible(worldPos)`: 1 where the drone camera sees the point (inside its frustum and not
 * behind something nearer), else 0. Depth is compared as linear distance, with a bias that grows
 * with range so ground seen at a grazing angle does not shadow itself.
 */
export const VIS_PARS = /* glsl */ `
uniform float uVisOn;
uniform mat4 uVisMatrix;
uniform sampler2D uVisDepth;
uniform vec2 uVisNearFar;
float emberVisible(vec3 p) {
    if (uVisOn < 0.5) return 1.0;
    vec4 c = uVisMatrix * vec4(p, 1.0);
    if (c.w <= 0.0) return 0.0;
    vec3 ndc = c.xyz / c.w;
    if (any(greaterThan(abs(ndc), vec3(1.0)))) return 0.0;
    float d = texture2D(uVisDepth, ndc.xy * 0.5 + 0.5).r;
    float n = uVisNearFar.x;
    float f = uVisNearFar.y;
    float seen = n * f / (f - d * (f - n));
    return c.w <= seen + 1.0 + 0.02 * c.w ? 1.0 : 0.0;
}
vec3 emberShade(vec3 rgb, vec3 p) {
    return rgb * mix(${UNSEEN_SHADE.toFixed(2)}, 1.0, emberVisible(p));
}
`;

/**
 * Patches a built-in material so what the drone cannot see is darkened. Chains any
 * `onBeforeCompile` the material already has.
 */
export function withVisibility<T extends Material>(material: T): T {
    const apply = 'gl_FragColor.rgb = emberShade(gl_FragColor.rgb, vVisWorld);';
    const previous = material.onBeforeCompile.bind(material);
    const key = material.onBeforeCompile.toString();
    material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        Object.assign(shader.uniforms, VIS_UNIFORMS);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vVisWorld;')
            .replace(
                '#include <project_vertex>',
                `#include <project_vertex>
vec4 visWorld = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
visWorld = instanceMatrix * visWorld;
#endif
vVisWorld = (modelMatrix * visWorld).xyz;`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vVisWorld;\n${VIS_PARS}`)
            .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${apply}`);
    };
    // Patched materials must not share a compiled program with unpatched ones.
    material.customProgramCacheKey = () => `${key}:visibility`;
    return material;
}

/** Renders depth from the drone camera each frame and points the world materials at it. */
export class DroneSight {
    readonly camera = new PerspectiveCamera(60, 4 / 3, 1, VIS_UNIFORMS.uVisNearFar.value.y);
    private readonly target: WebGLRenderTarget;

    constructor() {
        this.camera.layers.set(LAYER.WORLD);
        this.target = new WebGLRenderTarget(DEPTH_SIZE, DEPTH_SIZE, {
            depthTexture: new DepthTexture(DEPTH_SIZE, DEPTH_SIZE, UnsignedIntType),
        });
    }

    /** Call after the camera is placed (`applyDronePose`). */
    render(renderer: WebGLRenderer, scene: Scene): void {
        const cam = this.camera;
        // Square map stretched over the frustum; keep its texel aspect close to the camera's.
        const h = Math.round(DEPTH_SIZE / Math.max(1, cam.aspect));
        if (this.target.height !== h) this.target.setSize(DEPTH_SIZE, h);
        const u = VIS_UNIFORMS;
        u.uVisOn.value = 0;
        u.uVisDepth.value = placeholder;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(this.target);
        renderer.clear();
        renderer.render(scene, cam);
        renderer.setRenderTarget(previous);
        u.uVisMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        u.uVisNearFar.value.set(cam.near, cam.far);
        u.uVisDepth.value = this.target.depthTexture!;
        u.uVisOn.value = 1;
    }

    /** Before the drone's first pose: nothing is seen, so the whole world is dark. */
    blind(): void {
        VIS_UNIFORMS.uVisOn.value = 1;
        // All zeros puts every point at w = 0, which emberVisible treats as unseen.
        VIS_UNIFORMS.uVisMatrix.value.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}
