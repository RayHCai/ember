import { Resvg } from '@resvg/resvg-js';
import type {
    CivilianArea,
    EvacuationPath,
    LatLng,
    PlannerResult,
    Road,
    SafeZone,
} from '@ember/contracts';

/** What one area's evacuation map shows; every shape is the planner's or the api's. */
export type MapInput = {
    title: string;
    boundary: LatLng[];
    roads: Road[];
    area: CivilianArea;
    result: PlannerResult;
    safeZones: SafeZone[];
};

const SIZE = 1024;
const PAD = 56;
const FIRE = ['#7f1d1d', '#b91c1c', '#ea580c', '#f59e0b', '#fcd34d'];

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Equirectangular over the shown extent, north up, scaled to fit the square. */
function projector(points: LatLng[]) {
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const [south, north] = [Math.min(...lats), Math.max(...lats)];
    const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
    const k = Math.cos((((south + north) / 2) * Math.PI) / 180);
    const w = Math.max((east - west) * k, 1e-6);
    const h = Math.max(north - south, 1e-6);
    const scale = (SIZE - 2 * PAD) / Math.max(w, h);
    const ox = PAD + (SIZE - 2 * PAD - w * scale) / 2;
    const oy = PAD + (SIZE - 2 * PAD - h * scale) / 2;
    return (p: LatLng): [number, number] => [
        ox + (p.lng - west) * k * scale,
        oy + (north - p.lat) * scale,
    ];
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

function line(p: EvacuationPath | null, at: (q: LatLng) => [number, number], style: string) {
    return p && p.path.length > 1
        ? `<path d="${path(p.path, at)}" fill="none" ${style} stroke-linecap="round" stroke-linejoin="round"/>`
        : '';
}

export function renderMapSvg(input: MapInput): string {
    const { result, area } = input;
    const route = result.evacuationRoutes.find((r) => r.civilianAreaId === area.id) ?? null;
    const destination = route?.destination?.location ?? null;
    const extent = [
        ...input.boundary,
        area.center,
        ...(route?.path ?? []),
        ...(route?.alternate?.path ?? []),
        ...(destination ? [destination] : []),
    ];
    const at = projector(extent);
    const isochrones = result.fireSpread.isochrones.toSorted((a, b) => b.atMin - a.atMin);
    const fire = isochrones
        .map((iso, i) => {
            const color = FIRE[Math.min(FIRE.length - 1, isochrones.length - 1 - i)]!;
            return iso.polygons
                .map((poly) => {
                    const d = [poly.outer, ...poly.holes]
                        .map((ring) => path(ring, at, true))
                        .join(' ');
                    return `<path d="${d}" fill="${color}" fill-opacity="0.45" fill-rule="evenodd" stroke="${color}" stroke-width="1"/>`;
                })
                .join('');
        })
        .join('');
    const roads = input.roads
        .map((r) =>
            r.state === 'open'
                ? `<path d="${path(r.path, at)}" fill="none" stroke="#9ca3af" stroke-width="${r.kind === 'primary' || r.kind === 'motorway' ? 5 : 3}"/>`
                : `<path d="${path(r.path, at)}" fill="none" stroke="#dc2626" stroke-width="5" stroke-dasharray="10 8"/>`,
        )
        .join('');
    const [ax, ay] = at(area.center);
    const dest = destination ? at(destination) : null;
    const zone = input.safeZones.find((z) => z.id === route?.destination?.safeZoneId);
    const label = (x: number, y: number, text: string, color: string) =>
        `<text x="${x + 14}" y="${y + 6}" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="${color}" stroke="#ffffff" stroke-width="5" paint-order="stroke">${esc(text)}</text>`;
    const legend = [
        ['#16a34a', 'solid', 'Route out'],
        ['#0891b2', 'dash', 'Alternate'],
        ['#dc2626', 'dash', 'Road reported closed'],
        ['#ea580c', 'fill', `Forecast fire spread (to ${result.horizonMin} min)`],
    ]
        .map(([color, kind, text], i) => {
            const y = SIZE - 150 + i * 32;
            const mark =
                kind === 'fill'
                    ? `<rect x="40" y="${y - 12}" width="36" height="18" fill="${color}" fill-opacity="0.6"/>`
                    : `<line x1="40" y1="${y - 3}" x2="76" y2="${y - 3}" stroke="${color}" stroke-width="6" ${kind === 'dash' ? 'stroke-dasharray="8 6"' : ''}/>`;
            return `${mark}<text x="88" y="${y + 4}" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#111827">${esc(text!)}</text>`;
        })
        .join('');
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" fill="#f8fafc"/>`,
        `<path d="${path(input.boundary, at, true)}" fill="#dbeafe" fill-opacity="0.5" stroke="#2563eb" stroke-width="2" stroke-dasharray="6 6"/>`,
        roads,
        fire,
        line(
            route?.alternate ?? null,
            at,
            'stroke="#0891b2" stroke-width="8" stroke-dasharray="14 10"',
        ),
        line(route, at, 'stroke="#16a34a" stroke-width="10"'),
        `<circle cx="${ax}" cy="${ay}" r="12" fill="#111827" stroke="#ffffff" stroke-width="4"/>`,
        label(ax, ay, area.name, '#111827'),
        dest
            ? `<circle cx="${dest[0]}" cy="${dest[1]}" r="14" fill="#16a34a" stroke="#ffffff" stroke-width="4"/>${label(dest[0], dest[1], zone?.name ?? 'Exit', '#14532d')}`
            : '',
        `<rect x="0" y="0" width="${SIZE}" height="48" fill="#111827"/>`,
        `<text x="24" y="32" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">${esc(input.title)}</text>`,
        `<text x="${SIZE - 24}" y="${SIZE - 20}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#6b7280">Ember forecast, not an official order. North is up.</text>`,
        legend,
        '</svg>',
    ].join('');
}

export function renderMapPng(input: MapInput): Buffer {
    return Buffer.from(
        new Resvg(renderMapSvg(input), { font: { loadSystemFonts: true } }).render().asPng(),
    );
}
