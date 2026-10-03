import { PostProcessStage, type Scene } from "cesium";
import type { FilterId } from "../state/store";

// Map filters as Cesium post-process stages. Each runs on the rendered scene,
// so the HUD (plain DOM) stays readable whatever filter is on.

const COMMON = /* glsl */ `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;

float luminance(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vignette(vec2 uv, float strength) {
  vec2 d = uv - 0.5;
  return clamp(1.0 - strength * dot(d, d) * 2.0, 0.0, 1.0);
}
`;

// Luminance mapped to black, deep purple, red, orange, yellow, white.
const THERMAL = /* glsl */ `${COMMON}
vec3 ramp(float t) {
  const vec3 c0 = vec3(0.00, 0.00, 0.00);
  const vec3 c1 = vec3(0.22, 0.02, 0.36);
  const vec3 c2 = vec3(0.80, 0.06, 0.12);
  const vec3 c3 = vec3(1.00, 0.45, 0.02);
  const vec3 c4 = vec3(1.00, 0.86, 0.12);
  const vec3 c5 = vec3(1.00, 1.00, 1.00);
  float s = clamp(t, 0.0, 1.0) * 5.0;
  if (s < 1.0) return mix(c0, c1, s);
  if (s < 2.0) return mix(c1, c2, s - 1.0);
  if (s < 3.0) return mix(c2, c3, s - 2.0);
  if (s < 4.0) return mix(c3, c4, s - 3.0);
  return mix(c4, c5, s - 4.0);
}
void main() {
  vec3 color = texture(colorTexture, v_textureCoordinates).rgb;
  float heat = smoothstep(0.03, 0.75, luminance(color));
  out_FragColor = vec4(ramp(heat), 1.0);
}
`;

// Green phosphor intensifier with grain and a vignette.
const NIGHT = /* glsl */ `${COMMON}
void main() {
  vec2 uv = v_textureCoordinates;
  float l = luminance(texture(colorTexture, uv).rgb);
  // Lift shadows like an intensifier, but roll off highlights so bright
  // scenes keep their detail instead of clipping to solid green.
  l = 1.0 - exp(-2.2 * l);
  float grain = hash(uv * czm_viewport.zw + czm_frameNumber) - 0.5;
  l = clamp(l + grain * 0.08, 0.0, 1.0);
  vec3 phosphor = vec3(0.16, 0.92, 0.3) * l * vignette(uv, 0.9);
  out_FragColor = vec4(phosphor, 1.0);
}
`;

// Scanlines, a slight chromatic offset, and a vignette.
const CRT = /* glsl */ `${COMMON}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 offset = vec2(1.5 / czm_viewport.z, 0.0);
  vec3 color = vec3(
    texture(colorTexture, uv + offset).r,
    texture(colorTexture, uv).g,
    texture(colorTexture, uv - offset).b
  );
  color *= 0.82 + 0.18 * sin(uv.y * czm_viewport.w * 3.14159);
  color *= vignette(uv, 1.1);
  out_FragColor = vec4(color, 1.0);
}
`;

const SHADERS: Record<Exclude<FilterId, "normal">, string> = {
  thermal: THERMAL,
  night: NIGHT,
  crt: CRT,
};

export type FilterStages = Record<Exclude<FilterId, "normal">, PostProcessStage>;

export function createFilterStages(scene: Scene): FilterStages {
  const stages = {} as FilterStages;
  for (const [id, fragmentShader] of Object.entries(SHADERS) as [keyof FilterStages, string][]) {
    const stage = new PostProcessStage({ fragmentShader, name: `ember-filter-${id}` });
    stage.enabled = false;
    scene.postProcessStages.add(stage);
    stages[id] = stage;
  }
  return stages;
}

export function applyFilter(stages: FilterStages, filter: FilterId): void {
  for (const [id, stage] of Object.entries(stages)) {
    stage.enabled = id === filter;
  }
}
