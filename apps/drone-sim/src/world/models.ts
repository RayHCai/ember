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
const ROOT = '../../../../assets/';

/**
 * One model flattened to a single geometry for instancing: world-space position and face
 * normals, `color` = the face tint times its material colour, and `part` = 1 + the index of its
 * material in the `recolour` list (0: keep the baked colour). Recoloured parts carry only the
 * tint, for the instance colour to multiply; `colours` keeps what they were modelled with.
 */
export type BakedModel = {
    geometry: BufferGeometry;
    size: Record<string, number>;
    colours: Record<string, Color>;
};

/** Per growth form, its variants; per variant, its levels of detail from full to farthest. */
export type TreeModels = Record<Form, BakedModel[][]>;

export type BuildingKind = 'house' | 'block' | 'ruin';

/** One building of the kit: the footprint it was made for, at full detail and for far away. */
export type BuildingModel = {
    name: string;
    kind: BuildingKind;
    lengthM: number;
    widthM: number;
    /** Height of the walls (eave or roof deck); 0 for ruins. */
    wallHeightM: number;
    full: BakedModel;
    lod: BakedModel;
};

export type Models = {
    drone: Group;
    ground: BakedModel;
    trees: TreeModels;
    buildings: BuildingModel[];
    flames: BakedModel[];
    smoke: BakedModel[];
};

const VARIANTS = ['a', 'b'] as const;
const TREE_LODS = ['', '_lod1', '_lod2'] as const;
const FX_VARIANTS = ['a', 'b', 'c'] as const;

/** What the asset builder puts in the root node's extras. */
function extrasOf(root: Object3D): Record<string, unknown> {
    return (root.children[0] ?? root).userData as Record<string, unknown>;
}

export function bake(root: Object3D, recolour: readonly string[] = []): BakedModel {
    root.updateMatrixWorld(true);
    const position: number[] = [];
    const normal: number[] = [];
    const color: number[] = [];
    const part: number[] = [];
    const colours: Record<string, Color> = {};
    const v = new Vector3();
    const n = new Vector3();
    const nm = new Matrix3();
    const white = new Color(1, 1, 1);
    root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as Material & { color?: Color };
        const k = recolour.indexOf(material.name);
        if (k >= 0 && material.color) colours[material.name] = material.color.clone();
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
    const size = Object.fromEntries(
        Object.entries(extrasOf(root)).filter(
            (e): e is [string, number] => typeof e[1] === 'number',
        ),
    );
    return { geometry, size, colours };
}

async function load(name: string): Promise<Group> {
    const url = URLS[`${ROOT}${name}.glb`];
    if (!url) throw new Error(`assets/${name}.glb is missing (run uv run asset-builder)`);
    return (await new GLTFLoader().loadAsync(url)).scene;
}

/** Every building in `assets/buildings`, whatever the kit holds: the sim picks among them by size. */
export function buildingNames(paths: readonly string[] = Object.keys(URLS)): string[] {
    const prefix = `${ROOT}buildings/`;
    return paths
        .filter((p) => p.startsWith(prefix) && !p.endsWith('_lod1.glb'))
        .map((p) => p.slice(prefix.length, -'.glb'.length))
        .toSorted();
}

export function buildingModel(name: string, full: Group, lod: Group): BuildingModel {
    const extras = extrasOf(full);
    const kind = extras.kind;
    if (kind !== 'house' && kind !== 'block' && kind !== 'ruin')
        throw new Error(`buildings/${name}: unknown kind ${String(kind)}`);
    const recolour = kind === 'ruin' ? [] : ['roof', 'wall'];
    const baked = bake(full, recolour);
    const { lengthM, widthM, wallHeightM = 0 } = baked.size;
    if (!lengthM || !widthM) throw new Error(`buildings/${name}: no lengthM and widthM`);
    return { name, kind, lengthM, widthM, wallHeightM, full: baked, lod: bake(lod, recolour) };
}

/** Every model the sim draws, loaded in parallel. */
export async function loadModels(): Promise<Models> {
    const tree = (form: Form) =>
        Promise.all(
            VARIANTS.map((v) =>
                Promise.all(
                    TREE_LODS.map((lod) =>
                        load(`trees/${form}_${v}${lod}`).then((s) => bake(s, ['foliage'])),
                    ),
                ),
            ),
        );
    const [drone, ground, trees, buildings, flames, smoke] = await Promise.all([
        load('drone/quadcopter'),
        load('terrain/ground').then((s) => bake(s)),
        Promise.all(FORMS.map(async (form) => [form, await tree(form)] as const)).then(
            (entries) => Object.fromEntries(entries) as TreeModels,
        ),
        Promise.all(
            buildingNames().map(async (name) => {
                const [full, lod] = await Promise.all([
                    load(`buildings/${name}`),
                    load(`buildings/${name}_lod1`),
                ]);
                return buildingModel(name, full, lod);
            }),
        ),
        Promise.all(FX_VARIANTS.map((v) => load(`fx/flame_${v}`).then((s) => bake(s)))),
        Promise.all(FX_VARIANTS.map((v) => load(`fx/smoke_${v}`).then((s) => bake(s, ['smoke'])))),
    ]);
    return { drone, ground, trees, buildings, flames, smoke };
}
