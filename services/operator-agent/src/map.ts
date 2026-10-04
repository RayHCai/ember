import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type {
    CivilianArea,
    EvacuationRoute,
    LatLng,
    RiskZone,
    WatchZone,
    ZoneSurroundings,
} from '@ember/contracts';

/** What an evacuation map shows; every shape is the planner's or the api's. */
export type MapInput = {
    surroundings: ZoneSurroundings;
    /** The watch zone the drones map, where the fire was found. */
    zone: WatchZone;
    /** The route to draw, from the area it leaves to its destination. */
    route: EvacuationRoute;
    /** The area the route leaves. */
    from: CivilianArea | null;
    /** Areas burning now. */
    onFire: RiskZone[];
};

/** One 256 px web-mercator tile as PNG bytes, or null when it cannot be had. */
export type TileSource = (z: number, x: number, y: number) => Promise<Buffer | null>;

const TILE = 256;
const WIDTH = 1024;
const HEIGHT = 1024;
const PAD = 96;
const MAX_ZOOM = 17;
const FONT = 'DejaVu Sans';
const ATTRIBUTION = '© OpenStreetMap contributors';
// The service image has no system fonts, so labels use the packaged DejaVu files.
const fontDir = join(
    dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')),
    'ttf',
);

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Web-mercator pixel position at zoom `z`, as the tiles are drawn. */
function world(p: LatLng, z: number): [number, number] {
    const n = TILE * 2 ** z;
    const lat = Math.max(-85.05, Math.min(85.05, p.lat));
    const s = Math.sin((lat * Math.PI) / 180);
    return [((p.lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** The closest zoom at which every point fits inside the padded frame. */
function fitZoom(points: LatLng[]) {
    for (let z = MAX_ZOOM; z > 2; z--) {
        const px = points.map((p) => world(p, z));
        const w = Math.max(...px.map((p) => p[0])) - Math.min(...px.map((p) => p[0]));
        const h = Math.max(...px.map((p) => p[1])) - Math.min(...px.map((p) => p[1]));
        if (w <= WIDTH - 2 * PAD && h <= HEIGHT - 2 * PAD) return z;
    }
    return 2;
}

/** The view: zoom, the world pixel at the image's top left, and a projector into the image. */
export function frame(points: LatLng[]) {
    const z = fitZoom(points);
    const px = points.map((p) => world(p, z));
    const cx = (Math.max(...px.map((p) => p[0])) + Math.min(...px.map((p) => p[0]))) / 2;
    const cy = (Math.max(...px.map((p) => p[1])) + Math.min(...px.map((p) => p[1]))) / 2;
    const left = cx - WIDTH / 2;
    const top = cy - HEIGHT / 2;
    const at = (p: LatLng): [number, number] => {
        const [x, y] = world(p, z);
        return [x - left, y - top];
    };
    return { z, left, top, at };
}

function path(points: LatLng[], at: (p: LatLng) => [number, number], close = false) {
    const d = points.map(
        (p, i) =>
            `${i ? 'L' : 'M'}${at(p)
                .map((v) => v.toFixed(1))
                .join(' ')}`,
    );
    return d.join(' ') + (close ? ' Z' : '');
}

const text = (x: number, y: number, s: string, size: number, fill: string, extra = '') =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;

const label = (x: number, y: number, s: string) =>
    text(
        x + 16,
        y + 7,
        s,
        22,
        '#202124',
        'font-weight="700" stroke="#ffffff" stroke-width="5" paint-order="stroke"',
    );

/** A map pin whose point is at (x, y). */
const pin = (x: number, y: number, fill: string) =>
    `<path d="M${x} ${y} c-4 -14 -16 -20 -16 -32 a16 16 0 1 1 32 0 c0 12 -12 18 -16 32 z" fill="${fill}" stroke="#ffffff" stroke-width="3"/>` +
    `<circle cx="${x}" cy="${y - 32}" r="6" fill="#ffffff"/>`;

/** The tiles under the view, placed in image pixels. */
async function basemap(view: ReturnType<typeof frame>, tiles: TileSource) {
    const n = 2 ** view.z;
    const out: string[] = [];
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(view.top / TILE); ty * TILE < view.top + HEIGHT; ty++) {
        for (let tx = Math.floor(view.left / TILE); tx * TILE < view.left + WIDTH; tx++) {
            if (ty < 0 || ty >= n) continue;
            const x = tx * TILE - view.left;
            const y = ty * TILE - view.top;
            jobs.push(
                tiles(view.z, ((tx % n) + n) % n, ty).then((png) => {
                    if (png) {
                        out.push(
                            `<image x="${x}" y="${y}" width="${TILE}" height="${TILE}" href="data:image/png;base64,${png.toString('base64')}"/>`,
                        );
                    }
                }),
            );
        }
    }
    await Promise.all(jobs);
    return out.join('');
}

/**
 * Street map tiles framed on the watch zone, the fire and the route; the route drawn where it
 * runs, from the area it leaves to its destination.
 */
export async function renderMapSvg(input: MapInput, tiles: TileSource): Promise<string> {
    const { surroundings: s, zone, route, from } = input;
    const start = from?.center ?? route.path[0]!;
    const end = route.destination?.location ?? route.path.at(-1)!;
    const view = frame([
        ...route.path,
        start,
        end,
        ...zone.boundary,
        ...input.onFire.flatMap((z) => z.polygon),
    ]);
    const { at } = view;
    const area = from?.polygon
        ? `<path d="${path(from.polygon, at, true)}" fill="#1a73e8" fill-opacity="0.12" stroke="#1a73e8" stroke-width="2"/>`
        : '';
    const watch =
        zone.boundary.length > 2
            ? `<path d="${path(zone.boundary, at, true)}" fill="#fbbc04" fill-opacity="0.12" stroke="#202124" stroke-width="3" stroke-dasharray="10 6"/>`
            : '';
    const burning = input.onFire
        .filter((z) => z.polygon.length > 2)
        .map(
            (z) =>
                `<path d="${path(z.polygon, at, true)}" fill="#d93025" fill-opacity="0.5" stroke="#a50e0e" stroke-width="2"/>`,
        )
        .join('');
    // The route starts at the nearest road; the dotted leg joins it to the area it leaves.
    const leg = from
        ? `<path d="${path([start, route.path[0]!], at)}" fill="none" stroke="#1a73e8" stroke-width="5" stroke-linecap="round" stroke-dasharray="1 10"/>`
        : '';
    const line =
        `<path d="${path(route.path, at)}" fill="none" stroke="#ffffff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${path(route.path, at)}" fill="none" stroke="#1a73e8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
    const [sx, sy] = at(start);
    const [dx, dy] = at(end);
    const safe = s.safeZones.find((z) => z.id === route.destination?.safeZoneId);
    const [zx, zy] = zone.boundary.length ? at(zone.boundary[0]!) : [0, 0];
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        `<rect width="${WIDTH}" height="${HEIGHT}" fill="#e8eaed"/>`,
        await basemap(view, tiles),
        area,
        watch,
        burning,
        leg,
        line,
        zone.boundary.length ? label(zx - 16, zy - 20, zone.name) : '',
        `<circle cx="${sx}" cy="${sy}" r="20" fill="#1a73e8" fill-opacity="0.2"/>`,
        `<circle cx="${sx}" cy="${sy}" r="10" fill="#1a73e8" stroke="#ffffff" stroke-width="4"/>`,
        label(sx, sy, from?.name ?? 'Start'),
        pin(dx, dy, '#ea4335'),
        label(dx, dy - 32, safe?.name ?? 'Safe exit'),
        `<rect x="16" y="16" width="360" height="44" rx="8" fill="#ffffff" stroke="#dadce0"/>`,
        text(32, 45, 'Ember evacuation route', 22, '#202124', 'font-weight="700"'),
        `<rect x="${WIDTH - 470}" y="${HEIGHT - 30}" width="470" height="30" fill="#ffffff" fill-opacity="0.85"/>`,
        text(
            WIDTH - 10,
            HEIGHT - 10,
            `${ATTRIBUTION} · Ember forecast, not an official order`,
            14,
            '#3c4043',
            'text-anchor="end"',
        ),
        '</svg>',
    ].join('');
}

export async function renderMapPng(input: MapInput, tiles: TileSource): Promise<Buffer> {
    const png = new Resvg(await renderMapSvg(input, tiles), {
        font: {
            loadSystemFonts: false,
            fontFiles: [join(fontDir, 'DejaVuSans.ttf'), join(fontDir, 'DejaVuSans-Bold.ttf')],
            defaultFontFamily: FONT,
        },
    }).render();
    return Buffer.from(png.asPng());
}

/**
 * OpenStreetMap's standard tiles, as its tile usage policy asks: a real User-Agent, few requests
 * (one map per plan), and each tile kept once fetched.
 */
export function osmTiles(
    userAgent: string,
    url = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    fetchImpl: typeof fetch = fetch,
): TileSource {
    const cache = new Map<string, Promise<Buffer | null>>();
    return (z, x, y) => {
        const key = `${z}/${x}/${y}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const tile = fetchImpl(
            url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
            { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(10_000) },
        )
            .then(async (res) => (res.ok ? Buffer.from(await res.arrayBuffer()) : null))
            .catch(() => null);
        cache.set(key, tile);
        // A missing tile is asked for again with the next map.
        void tile.then((png) => png ?? cache.delete(key));
        return tile;
    };
}
