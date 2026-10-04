import { Color, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { Scene } from 'three';
import type { FireField } from './fireField';
import type { BakedModel } from './models';
import { LAYER, withVisibility } from './visibility';

/** Flame height (m) at full intensity, by Demo Data fuel class. */
const FLAME_HEIGHT_M: Record<number, number> = { 1: 3, 2: 5, 3: 13, 4: 7, 5: 11, 6: 1.5 };
const MAX_FLAMES = 16000;

const hash = (i: number, k: number): number => {
    const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return s - Math.floor(s);
};

/** The `assets/` flame for a fuel: tall single tongues on trees and buildings, low spread on grass. */
function variantFor(baseHeightM: number): number {
    if (baseHeightM >= 10) return 0;
    if (baseHeightM >= 5) return 1;
    return 2;
}

// The models are static; each instance flickers and sways on its own phase.
const BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
float fSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
float fT = uTime * (5.0 + 3.0 * fSeed) + fSeed * 40.0;
transformed.y *= 0.84 + 0.16 * sin(fT) + 0.07 * sin(fT * 2.7);
transformed.xz *= 1.0 + 0.06 * sin(fT * 1.9 + position.y * 3.0);
transformed.x += 0.08 * position.y * sin(fT * 0.7 + 1.3);
`;

/**
 * Flames on every burning cell of the fire model, as instanced `assets/` flame models (unlit: their
 * colours are the light), rebuilt whenever the fire state changes.
 */
export class Flames {
    private readonly meshes: InstancedMesh[];
    private readonly uniforms = { uTime: { value: 0 } };

    constructor(
        scene: Scene,
        private readonly fire: FireField,
        models: BakedModel[],
    ) {
        const material = new MeshBasicMaterial({ vertexColors: true });
        material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.uniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nuniform float uTime;')
                .replace('#include <begin_vertex>', BEGIN);
        };
        withVisibility(material);
        this.meshes = models.map((model) => {
            const mesh = new InstancedMesh(model.geometry, material, MAX_FLAMES);
            // Create the instance colours now, so the first compiled program already uses them.
            mesh.setColorAt(0, new Color(1, 1, 1));
            mesh.count = 0;
            mesh.frustumCulled = false;
            mesh.layers.set(LAYER.EFFECTS);
            scene.add(mesh);
            return mesh;
        });
    }

    /** Rebuild instances from the fire field's burning cells. */
    rebuild(): void {
        const { fire } = this;
        const { fuel } = fire.grid;
        const counts = this.meshes.map(() => 0);
        const m = new Matrix4();
        const q = new Quaternion();
        const up = new Vector3(0, 1, 0);
        const pos = new Vector3();
        const scale = new Vector3();
        const glow = new Color();
        let total = 0;
        for (let k = 0; k < fire.burningCount && total < MAX_FLAMES; k++) {
            const i = fire.burning[k]!;
            const inten = fire.intensity[i]!;
            const base = FLAME_HEIGHT_M[fuel[i]!] ?? 3;
            const c = fire.cellCentre(i);
            const v = variantFor(base);
            const mesh = this.meshes[v]!;
            const tongues = base > 6 ? 2 : 1;
            for (let t = 0; t < tongues && total < MAX_FLAMES; t++) {
                const h = base * (0.45 + 0.9 * inten) * (0.7 + 0.6 * hash(i, t + 3));
                pos.set(c.x + (hash(i, t) - 0.5) * 9, 0, -(c.y + (hash(i, t + 1) - 0.5) * 9));
                q.setFromAxisAngle(up, hash(i, t + 2) * Math.PI * 2);
                scale.setScalar(h);
                const n = counts[v]!++;
                mesh.setMatrixAt(n, m.compose(pos, q, scale));
                // Weaker fire burns dimmer; the instance colour multiplies the model's.
                mesh.setColorAt(n, glow.setScalar(0.55 + 0.45 * inten));
                total++;
            }
        }
        this.meshes.forEach((mesh, v) => {
            mesh.count = counts[v]!;
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) {
                mesh.instanceColor.clearUpdateRanges();
                mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
                mesh.instanceColor.needsUpdate = true;
            }
        });
    }

    update(timeS: number): void {
        this.uniforms.uTime.value = timeS;
    }
}
