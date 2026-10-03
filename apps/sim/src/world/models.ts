import { BufferGeometry, Color, Float32BufferAttribute, Matrix3, Vector3 } from 'three';
import type { Group, Material, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Form } from './assets';
import { FORMS } from './assets';

/** The low-poly models in the repo's `assets/` (tools/asset-builder); see assets/README.md. */
const URLS = import.meta.glob('../../../../assets/**/*.glb', {
    query: '?url',
    import: 'default',
    eager: true,
}) as Record<string, string>;

/**
 * One model flattened to a single geometry for instancing: world-space position and face
 * normals, `color` = the face tint times its material colour, and `part` = 1 + the index of its
 * material in the `recolour` list (0: keep the baked colour). Recoloured parts carry only the
 * tint, for the instance colour to multiply.
 */
export type BakedModel = { geometry: BufferGeometry; size: Record<string, number> };

export type TreeModels = Record<Form, { full: BakedModel[]; lod: BakedModel[] }>;

export type BuildingKind = 'house_gable' | 'house_hip' | 'shop';

export type Models = {
    drone: Group;
    trees: TreeModels;
    buildings: Record<BuildingKind | 'ruin', BakedModel>;
    flames: BakedModel[];
    smoke: BakedModel[];
};

const VARIANTS = ['a', 'b'] as const;
const FX_VARIANTS = ['a', 'b', 'c'] as const;

/** The sizes the asset builder puts in the root node's extras. */
function sizesOf(root: Object3D): Record<string, number> {
    const node = root.children[0] ?? root;
    return Object.fromEntries(
        Object.entries(node.userData).filter(
            (e): e is [string, number] => typeof e[1] === 'number',
        ),
    );
}

export function bake(root: Object3D, recolour: readonly string[] = []): BakedModel {
    root.updateMatrixWorld(true);
    const position: number[] = [];
    const normal: number[] = [];
    const color: number[] = [];
    const part: number[] = [];
    const v = new Vector3();
    const n = new Vector3();
    const nm = new Matrix3();
    const white = new Color(1, 1, 1);
    root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as Material & { color?: Color };
        const k = recolour.indexOf(material.name);
        const base = k >= 0 ? white : (material.color ?? white);
        // The models are unindexed with one normal per face; keep them that way (faceted look).
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
        const p = g.getAttribute('position');
        const nrm = g.getAttribute('normal');
        const tint = g.getAttribute('color');
        nm.getNormalMatrix(mesh.matrixWorld);
        for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
            n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
            position.push(v.x, v.y, v.z);
            normal.push(n.x, n.y, n.z);
            const t = tint ? [tint.getX(i), tint.getY(i), tint.getZ(i)] : [1, 1, 1];
            color.push(t[0]! * base.r, t[1]! * base.g, t[2]! * base.b);
            part.push(k + 1);
        }
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(color, 3));
    geometry.setAttribute('part', new Float32BufferAttribute(part, 1));
    geometry.computeBoundingSphere();
    return { geometry, size: sizesOf(root) };
}

async function load(name: string): Promise<Group> {
    const url = URLS[`../../../../assets/${name}.glb`];
    if (!url) throw new Error(`assets/${name}.glb is missing (run uv run asset-builder)`);
    return (await new GLTFLoader().loadAsync(url)).scene;
}

/** Every model the sim draws, loaded in parallel. */
export async function loadModels(): Promise<Models> {
    const tree = (form: Form, lod: boolean) =>
        Promise.all(
            VARIANTS.map((v) =>
                load(`trees/${form}_${v}${lod ? '_lod1' : ''}`).then((s) => bake(s, ['foliage'])),
            ),
        );
    const building = (name: string, recolour: string[]) =>
        load(`buildings/${name}`).then((s) => bake(s, recolour));
    const [drone, trees, houseGable, houseHip, shop, ruin, flames, smoke] = await Promise.all([
        load('drone/quadcopter'),
        Promise.all(
            FORMS.map(async (form) => {
                const [full, lod] = await Promise.all([tree(form, false), tree(form, true)]);
                return [form, { full, lod }] as const;
            }),
        ).then((entries) => Object.fromEntries(entries) as TreeModels),
        building('house_gable', ['roof', 'wall']),
        building('house_hip', ['roof', 'wall']),
        building('shop', ['roof', 'wall']),
        building('ruin', []),
        Promise.all(FX_VARIANTS.map((v) => load(`fx/flame_${v}`).then((s) => bake(s)))),
        Promise.all(FX_VARIANTS.map((v) => load(`fx/smoke_${v}`).then((s) => bake(s, ['smoke'])))),
    ]);
    return {
        drone,
        trees,
        buildings: { house_gable: houseGable, house_hip: houseHip, shop, ruin },
        flames,
        smoke,
    };
}
