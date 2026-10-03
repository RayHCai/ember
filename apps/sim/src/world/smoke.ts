import {
    Color,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    MeshLambertMaterial,
    Quaternion,
    Vector3,
} from 'three';
import type { Scene } from 'three';
import type { FireField } from './fireField';
import type { BakedModel } from './models';
import { LAYER, withVisibility } from './visibility';

type Particle = {
    x: number;
    y: number;
    h: number;
    age: number;
    life: number;
    seed: number;
    size0: number;
    variant: number;
};

const MAX_PARTICLES = 4000;

const PARS = /* glsl */ `
attribute vec2 aLook; // alpha, firelight (1 fresh off the flames, 0 drifted away)
varying vec2 vLook;
varying float vHeight;
`;

// Puffs right in front of the lens would fill the screen; fade them out and skip drawing them.
const PROJECT = /* glsl */ `
vec3 sCentre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float sNear = smoothstep(0.7, 2.4, length(cameraPosition - sCentre) / length(instanceMatrix[0].xyz));
vLook = vec2(aLook.x * sNear, aLook.y);
vHeight = sCentre.y;
if (sNear < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

/**
 * Smoke columns rising from burning and smouldering cells, drifting downwind: instanced `assets/`
 * smoke puffs, lit by the sun, that grow and fade as they age.
 */
export class Smoke {
    private readonly particles: Particle[] = [];
    private readonly meshes: InstancedMesh[];
    private readonly looks: InstancedBufferAttribute[];
    private readonly glow = { value: new Color(0, 0, 0) };
    private readonly downwind: { e: number; n: number };
    private carry = 0;

    constructor(
        scene: Scene,
        private readonly fire: FireField,
        windFromDeg: number,
        models: BakedModel[],
    ) {
        const to = ((windFromDeg + 180) * Math.PI) / 180;
        this.downwind = { e: Math.sin(to), n: Math.cos(to) };
        // The puffs' `smoke` material is recoloured here; the model keeps its facet tints.
        const material = new MeshLambertMaterial({
            color: new Color().setRGB(0.44, 0.41, 0.38, 'srgb'),
            vertexColors: true,
            transparent: true,
            depthWrite: false,
        });
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uGlow = this.glow;
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${PARS}`)
                .replace('#include <project_vertex>', `#include <project_vertex>\n${PROJECT}`);
            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    '#include <common>\nuniform vec3 uGlow;\nvarying vec2 vLook;\nvarying float vHeight;',
                )
                .replace(
                    '#include <color_fragment>',
                    '#include <color_fragment>\ndiffuseColor.a *= vLook.x;',
                )
                // Firelight on the underside of the plume, as in compositor.py.
                .replace(
                    '#include <emissivemap_fragment>',
                    '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlow * vLook.y * exp(-vHeight / 150.0);',
                );
        };
        withVisibility(material, 'hide');
        this.looks = [];
        this.meshes = models.map((model) => {
            const mesh = new InstancedMesh(model.geometry.clone(), material, MAX_PARTICLES);
            const look = new InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 2), 2);
            mesh.geometry.setAttribute('aLook', look);
            mesh.count = 0;
            mesh.frustumCulled = false;
            mesh.renderOrder = 2;
            mesh.layers.set(LAYER.EFFECTS);
            this.looks.push(look);
            scene.add(mesh);
            return mesh;
        });
    }

    private emit(count: number): void {
        const f = this.fire;
        const pool = f.burningCount + f.smoulderingCount;
        if (pool === 0) return;
        for (let k = 0; k < count && this.particles.length < MAX_PARTICLES; k++) {
            const pick = Math.floor(Math.random() * pool);
            const i =
                pick < f.burningCount ? f.burning[pick]! : f.smouldering[pick - f.burningCount]!;
            const strength = pick < f.burningCount ? f.intensity[i]! : f.smoulder[i]! * 0.4;
            if (Math.random() > strength + 0.05) continue;
            const c = f.cellCentre(i);
            this.particles.push({
                x: c.x + (Math.random() - 0.5) * 10,
                y: c.y + (Math.random() - 0.5) * 10,
                h: 4 + Math.random() * 6,
                age: 0,
                life: 110 + Math.random() * 90,
                seed: Math.random(),
                size0: 10 + 14 * strength,
                variant: Math.floor(Math.random() * this.meshes.length),
            });
        }
    }

    /** `dark` 0..1 makes the fire's glow on the smoke stronger at night. */
    update(dt: number, timeS: number, dark: number): void {
        const f = this.fire;
        const rate = Math.min(200, 8 + f.totalIntensity * 0.8 + f.smoulderingCount * 0.004);
        this.carry += f.burningCount + f.smoulderingCount > 0 ? rate * dt : 0;
        const whole = Math.floor(this.carry);
        this.carry -= whole;
        this.emit(whole);

        const counts = this.meshes.map(() => 0);
        const m = new Matrix4();
        const q = new Quaternion();
        const axis = new Vector3();
        const pos = new Vector3();
        const scale = new Vector3();
        for (let k = this.particles.length - 1; k >= 0; k--) {
            const p = this.particles[k]!;
            p.age += dt;
            if (p.age >= p.life) {
                this.particles[k] = this.particles[this.particles.length - 1]!;
                this.particles.pop();
                continue;
            }
            const drift = 4 + p.h * 0.012;
            p.x += this.downwind.e * drift * dt;
            p.y += this.downwind.n * drift * dt;
            p.h += (0.6 + 5 * Math.exp(-p.age / 35)) * dt;
            const u = p.age / p.life;
            // Puff diameter; the models are one metre in radius.
            const size = p.size0 + 260 * Math.sqrt(u);
            // Thin near the flames (hot gases rise before the plume thickens), fading out at the end.
            const alpha = Math.min(1, p.age / 12) * (1 - Math.max(0, (u - 0.6) / 0.4)) * 0.36;
            axis.set(Math.sin(p.seed * 17), 2, Math.cos(p.seed * 23)).normalize();
            q.setFromAxisAngle(axis, p.seed * Math.PI * 2 + timeS * 0.02);
            pos.set(p.x, p.h, -p.y);
            scale.set(size / 2, size * 0.4, size / 2);
            const n = counts[p.variant]!++;
            this.meshes[p.variant]!.setMatrixAt(n, m.compose(pos, q, scale));
            this.looks[p.variant]!.setXY(n, alpha, Math.exp(-p.age / 25));
        }
        this.meshes.forEach((mesh, v) => {
            mesh.count = counts[v]!;
            mesh.instanceMatrix.needsUpdate = true;
            this.looks[v]!.needsUpdate = true;
        });
        const glow = 0.15 + 0.6 * dark;
        this.glow.value.setRGB(glow, 0.22 * glow, 0.03 * glow);
    }
}
