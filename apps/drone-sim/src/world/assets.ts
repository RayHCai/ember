import type { Extent, WorldFrame } from './frame';

/** Growth forms in the order Demo Data numbers them (`vegetation.forms`). */
export const FORMS = ['broadleaf', 'conifer', 'palm', 'umbrella', 'shrub'] as const;
export type Form = (typeof FORMS)[number];

export const TREE_FIELDS = [
    'x',
    'y',
    'height_m',
    'crown_radius_m',
    'form',
    'r',
    'g',
    'b',
    'arrival_min',
    'flame_min',
    'survives',
    'seed',
] as const;

export type Building = {
    id: number;
    footprint: [number, number][];
    heightM: number;
    roof: 'flat' | 'gable';
    gable?: { cx: number; cy: number; lengthM: number; widthM: number; angleRad: number };
    roofRgb: [number, number, number];
    ignitionMin: number | null;
    flameMin: number;
    destroyed: boolean;
};

/** A road centreline in the world frame with its paved width. */
export type Road = { widthM: number; points: [number, number][] };

export type FireGrid = {
    width: number;
    height: number;
    cellM: number;
    extent: Extent;
    neverMin: number;
    /** Per cell: arrival_min, flame_min, smoulder_min, heat. Rows run south to north. */
    cells: Float32Array;
    fuel: Uint8Array;
};

export type WorldAssets = {
    frame: WorldFrame;
    extent: Extent;
    rekindleMs: number;
    windFromDeg: number;
    trees: Float32Array;
    treeStride: number;
    buildings: Building[];
    roads: Road[];
    fire: FireGrid;
};

export type LoadProgress = (step: string, done: number, total: number) => void;

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        throw new Error(`world manifest: ${what} missing`);
    return v as Json;
}

function num(v: unknown, what: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v))
        throw new Error(`world manifest: ${what} is not a number`);
    return v;
}

function str(v: unknown, what: string): string {
    if (typeof v !== 'string') throw new Error(`world manifest: ${what} is not a string`);
    return v;
}

function extentOf(v: unknown, what: string): Extent {
    const e = obj(v, what);
    return {
        minX: num(e.min_x, `${what}.min_x`),
        minY: num(e.min_y, `${what}.min_y`),
        maxX: num(e.max_x, `${what}.max_x`),
        maxY: num(e.max_y, `${what}.max_y`),
    };
}

async function fetchOk(url: string): Promise<Response> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return res;
}

function building(v: unknown): Building {
    const b = obj(v, 'building');
    const g = b.gable === undefined ? undefined : obj(b.gable, 'gable');
    return {
        id: num(b.id, 'building.id'),
        footprint: b.footprint as [number, number][],
        heightM: num(b.height_m, 'building.height_m'),
        roof: b.roof === 'gable' ? 'gable' : 'flat',
        gable: g && {
            cx: num(g.cx, 'gable.cx'),
            cy: num(g.cy, 'gable.cy'),
            lengthM: num(g.length_m, 'gable.length_m'),
            widthM: num(g.width_m, 'gable.width_m'),
            angleRad: num(g.angle_rad, 'gable.angle_rad'),
        },
        roofRgb: b.roof_rgb as [number, number, number],
        ignitionMin: b.ignition_min === null ? null : num(b.ignition_min, 'building.ignition_min'),
        flameMin: num(b.flame_min, 'building.flame_min'),
        destroyed: b.destroyed === true,
    };
}

function road(v: unknown): Road {
    const r = obj(v, 'road');
    return { widthM: num(r.width_m, 'road.width_m'), points: r.points as [number, number][] };
}

/** Everything the 3D world needs from Demo Data's `/v1/world` (built there on first request). */
export async function loadWorld(baseUrl: string, progress: LoadProgress): Promise<WorldAssets> {
    const base = baseUrl.replace(/\/$/, '');
    progress('Reconstructing world (first run takes a few minutes)', 0, 5);
    const m = obj(await (await fetchOk(`${base}/v1/world`)).json(), 'manifest');
    const frameJson = obj(m.frame, 'frame');
    const origin = obj(frameJson.origin, 'frame.origin');
    const mpd = obj(frameJson.metres_per_degree, 'frame.metres_per_degree');
    const frame: WorldFrame = {
        lat0: num(origin.lat, 'origin.lat'),
        lng0: num(origin.lon, 'origin.lon'),
        mLat: num(mpd.lat, 'metres_per_degree.lat'),
        mLng: num(mpd.lon, 'metres_per_degree.lon'),
    };
    const scenario = obj(m.scenario, 'scenario');
    const veg = obj(m.vegetation, 'vegetation');
    const fireJson = obj(m.fire, 'fire');
    const fields = veg.fields as string[];
    if (fields.join() !== TREE_FIELDS.join())
        throw new Error(`world manifest: unexpected tree fields ${fields.join()}`);
    const forms = veg.forms as string[];
    if (forms.join() !== FORMS.join())
        throw new Error(`world manifest: unexpected growth forms ${forms.join()}`);

    let done = 1;
    const step = <T>(label: string, p: Promise<T>): Promise<T> =>
        p.then((v) => {
            done += 1;
            progress(label, done, 5);
            return v;
        });
    const json = (url: string): Promise<unknown> => fetchOk(base + url).then((r) => r.json());
    const [treesBuf, buildingsJson, roadsJson, fireBuf] = await Promise.all([
        step(
            'Trees',
            fetchOk(base + str(veg.url, 'vegetation.url')).then((r) => r.arrayBuffer()),
        ),
        step('Buildings', json(str(obj(m.buildings, 'buildings').url, 'buildings.url'))),
        step('Roads', json(str(obj(m.roads, 'roads').url, 'roads.url'))),
        step(
            'Fire model',
            fetchOk(base + str(fireJson.url, 'fire.url')).then((r) => r.arrayBuffer()),
        ),
    ]);

    const width = num(fireJson.width, 'fire.width');
    const height = num(fireJson.height, 'fire.height');
    const n = width * height;
    if (fireBuf.byteLength !== n * 17)
        throw new Error(`fire grid: expected ${n * 17} bytes, got ${fireBuf.byteLength}`);
    const trees = new Float32Array(treesBuf);
    if (trees.length % TREE_FIELDS.length !== 0)
        throw new Error('vegetation: truncated tree records');

    return {
        frame,
        extent: extentOf(m.extent, 'extent'),
        rekindleMs: Date.parse(str(scenario.rekindle, 'scenario.rekindle')),
        windFromDeg: num(scenario.wind_from_deg, 'scenario.wind_from_deg'),
        trees,
        treeStride: TREE_FIELDS.length,
        buildings: (obj(buildingsJson, 'buildings').buildings as unknown[]).map(building),
        roads: (obj(roadsJson, 'roads').roads as unknown[]).map(road),
        fire: {
            width,
            height,
            cellM: num(fireJson.cell_m, 'fire.cell_m'),
            extent: extentOf(fireJson.extent, 'fire.extent'),
            neverMin: num(fireJson.never_min, 'fire.never_min'),
            cells: new Float32Array(fireBuf, 0, n * 4),
            fuel: new Uint8Array(fireBuf, n * 16, n),
        },
    };
}
