import { Cartesian3, Color } from 'cesium';
import { glyphSvg, type GlyphName } from '../icons/glyphs';
import type { LatLon } from '../sim/types';

// Map colors. Blue is the boundary, pink is connectivity, yellow and red are risk and fire.
export const HEX = {
    ink: '#1C1714',
    white: '#FFFFFF',
    flame: '#F2541B',
    boundary: '#2F6BFF',
    pink: '#FF4FA3',
    risk: '#F2A900',
    fire: '#E5321B',
    route: '#12A37A',
    responder: '#0E8FD8',
    civilian: '#B5179E',
    forest: '#2E9E5B',
} as const;

export const C = Object.fromEntries(
    Object.entries(HEX).map(([k, v]) => [k, Color.fromCssColorString(v)]),
) as Record<keyof typeof HEX, Color>;

export const LABEL_FONT = '600 12px "Geist Variable", system-ui, sans-serif';
export const MONO_FONT = '500 11px "Geist Mono Variable", ui-monospace, monospace';

/** Keeps icons and labels visible above terrain and 3D tiles. */
export const ALWAYS_ON_TOP = Number.POSITIVE_INFINITY;

export function toCartesian([lat, lon]: LatLon, height = 0): Cartesian3 {
    return Cartesian3.fromDegrees(lon, lat, height);
}

function url(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function badge(
    name: GlyphName,
    fill: string,
    glyph: string,
    shape: 'square' | 'circle',
    stroke?: string,
): string {
    return url(
        glyphSvg(name, {
            size: 64,
            fill: glyph,
            seam: fill,
            seamWidth: 1.1,
            badge: { shape, fill, stroke },
        }),
    );
}

export const ICONS = {
    server: badge('server', HEX.ink, HEX.white, 'square'),
    serverPending: badge('server', HEX.pink, HEX.white, 'square'),
    drone: badge('drone', HEX.ink, HEX.white, 'circle', HEX.white),
    droneActive: badge('drone', HEX.flame, HEX.white, 'circle', HEX.white),
    fire: badge('flame', HEX.fire, HEX.white, 'circle', HEX.white),
    report: badge('camera', HEX.white, HEX.flame, 'circle', HEX.flame),
    reportVerified: badge('camera', HEX.flame, HEX.white, 'circle', HEX.white),
    community: badge('home', HEX.white, HEX.ink, 'circle', HEX.ink),
    safe: badge('shield', HEX.route, HEX.white, 'circle', HEX.white),
    drop: badge('target', HEX.responder, HEX.white, 'circle', HEX.white),
} as const;
