// Every icon is built like the Ember mark (assets/brand/icon.svg): flat facets
// separated by seams. Points live on a 24 by 24 grid. A `cut` facet is drawn in the seam
// color, which punches a hole (a door, a pupil, a keyhole).

import markSvg from '../../../../assets/brand/icon.svg?raw';

export interface Facet {
    points: string;
    cut?: boolean;
}

type Pt = [number, number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const str = (pts: Pt[]) => pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ');
const f = (points: string): Facet => ({ points });
const cut = (points: string): Facet => ({ points, cut: true });

function parse(points: string): Pt[] {
    return points.split(' ').map((p) => p.split(',').map(Number) as Pt);
}

function ngon(cx: number, cy: number, r: number, n: number, rotDeg = -90): Pt[] {
    return Array.from({ length: n }, (_, i) => {
        const a = ((rotDeg + (360 * i) / n) * Math.PI) / 180;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
    });
}

/** Triangles from a centre to each edge: the low-poly look in one call. */
function fan(center: Pt, outline: Pt[]): Facet[] {
    return outline.map((p, i) => f(str([center, p, outline[(i + 1) % outline.length]!])));
}

/** A polygon cut in two across its first and middle vertex. */
function halves(outline: Pt[], asCut = false): Facet[] {
    const mid = Math.floor(outline.length / 2);
    const a = str(outline.slice(0, mid + 1));
    const b = str([...outline.slice(mid), outline[0]!]);
    return asCut ? [cut(a), cut(b)] : [f(a), f(b)];
}

function ring(
    cx: number,
    cy: number,
    R: number,
    r: number,
    n: number,
    rot = -90,
    skip: number[] = [],
): Facet[] {
    const outer = ngon(cx, cy, R, n, rot);
    const inner = ngon(cx, cy, r, n, rot);
    const out: Facet[] = [];
    for (let i = 0; i < n; i++) {
        if (skip.includes(i)) continue;
        const j = (i + 1) % n;
        out.push(f(str([outer[i]!, outer[j]!, inner[j]!, inner[i]!])));
    }
    return out;
}

function star(cx: number, cy: number, R: number, r: number, points: number): Pt[] {
    return Array.from({ length: points * 2 }, (_, i) => {
        const a = ((-90 + (180 * i) / points) * Math.PI) / 180;
        const radius = i % 2 === 0 ? R : r;
        return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as Pt;
    });
}

/** A four-point star as four kite facets, one per point. */
function kites(cx: number, cy: number, R: number, r: number): Facet[] {
    const p = star(cx, cy, R, r, 4);
    return [0, 2, 4, 6].map((i) => f(str([[cx, cy], p[(i + 7) % 8]!, p[i]!, p[i + 1]!])));
}

function rect(x0: number, y0: number, x1: number, y1: number): Facet[] {
    return [
        f(
            str([
                [x0, y0],
                [x1, y0],
                [x1, y1],
            ]),
        ),
        f(
            str([
                [x0, y0],
                [x1, y1],
                [x0, y1],
            ]),
        ),
    ];
}

function transform(facets: Facet[], fn: (p: Pt) => Pt): Facet[] {
    return facets.map((x) => ({ ...x, points: str(parse(x.points).map(fn)) }));
}

// The Ember mark's facets, read from the shared icon (1024 grid) so the two cannot drift.
export const MARK_FACETS = Array.from(markSvg.matchAll(/<polygon points="([^"]+)"/g), (m) => m[1]!);

const flame = transform(MARK_FACETS.map(f), ([x, y]) => [
    (x - 513) * 0.0305 + 12,
    (y - 509) * 0.0305 + 12,
]);

const chevronRight = [f('8,3.5 11.5,3.5 19,12 15.5,12'), f('15.5,12 19,12 11.5,20.5 8,20.5')];
const arrowLeft = [
    f('2.5,12 10.5,4.2 10.5,12'),
    f('2.5,12 10.5,12 10.5,19.8'),
    f('10.5,10.3 21.5,10.3 21.5,13.7 10.5,13.7'),
];

export const GLYPHS = {
    flame,
    server: [
        f('12,1.8 14.6,5.6 9.4,5.6'),
        f('5,6.6 19,6.6 12,11.2'),
        f('5,6.6 12,11.2 5,11.2'),
        f('19,6.6 19,11.2 12,11.2'),
        f('5,12.2 19,12.2 12,16.8'),
        f('5,12.2 12,16.8 5,16.8'),
        f('19,12.2 19,16.8 12,16.8'),
        f('7.5,17.8 16.5,17.8 12,22.2'),
        f('7.5,17.8 12,22.2 4.5,22.2'),
        f('16.5,17.8 19.5,22.2 12,22.2'),
    ],
    drone: [
        f('10.3,8.6 8.6,10.3 5.6,7.3 7.3,5.6'),
        f('13.7,8.6 15.4,10.3 18.4,7.3 16.7,5.6'),
        f('10.3,15.4 8.6,13.7 5.6,16.7 7.3,18.4'),
        f('13.7,15.4 15.4,13.7 18.4,16.7 16.7,18.4'),
        ...fan([12, 12], ngon(12, 12, 4, 4)),
        ...halves(ngon(5.2, 5.2, 3.3, 6, 0)),
        ...halves(ngon(18.8, 5.2, 3.3, 6, 0)),
        ...halves(ngon(5.2, 18.8, 3.3, 6, 0)),
        ...halves(ngon(18.8, 18.8, 3.3, 6, 0)),
    ],
    search: [
        ...ring(10.5, 10.5, 7.2, 4.4, 6),
        f('15.4,15.6 17.4,13.6 22,18.2'),
        f('15.4,15.6 22,18.2 20,20.2'),
    ],
    plus: [
        f('10.4,3.5 13.6,3.5 13.6,20.5 10.4,20.5'),
        f('3.5,10.4 10.4,10.4 10.4,13.6 3.5,13.6'),
        f('13.6,10.4 20.5,10.4 20.5,13.6 13.6,13.6'),
    ],
    close: [f('4.5,6.7 6.7,4.5 19.5,17.3 17.3,19.5'), f('17.3,4.5 19.5,6.7 6.7,19.5 4.5,17.3')],
    arrowLeft,
    arrowRight: transform(arrowLeft, ([x, y]) => [24 - x, y]),
    chevronRight,
    chevronDown: transform(chevronRight, ([x, y]) => [24 - y, x]),
    bell: [
        ...fan([12, 10], parse('12,2.8 16.8,6.5 17.8,15.5 6.2,15.5 7.2,6.5')),
        f('3.5,15.5 20.5,15.5 12,18'),
        f('3.5,15.5 12,18 5,18'),
        f('20.5,15.5 19,18 12,18'),
        f('9.8,19 14.2,19 12,21.8'),
    ],
    sparkle: [...kites(10.5, 13.5, 9, 3.1), ...kites(18.8, 5.2, 4, 1.5)],
    send: [f('2,10.8 22,2.5 11,13'), f('11,13 22,2.5 15,21.5'), f('11,13 15,21.5 10.4,16.6')],
    play: [f('6,3.5 20.5,12 9.5,12'), f('6,3.5 9.5,12 6,20.5'), f('6,20.5 9.5,12 20.5,12')],
    stop: fan([12, 12], parse('5,5 19,5 19,19 5,19')),
    layers: [
        f('12,2.5 12,13 2.5,7.8'),
        f('12,2.5 21.5,7.8 12,13'),
        f('2.5,11.6 5.4,10 12,13.7 12,17'),
        f('12,13.7 18.6,10 21.5,11.6 12,17'),
        f('2.5,15.9 5.4,14.3 12,18 12,21.3'),
        f('12,18 18.6,14.3 21.5,15.9 12,21.3'),
    ],
    clock: [
        ...ring(12, 12, 10, 7.6, 8, -67.5),
        f('11,5.8 13,5.8 13,12.6 11,12.6'),
        f('11.6,11.1 17.2,14.1 16.3,15.8 10.7,12.8'),
    ],
    users: [
        ...halves(ngon(9, 7.2, 3.8, 6, 0)),
        f('2.5,20.5 3.8,14.6 9,12.6 9,20.5'),
        f('9,12.6 14.2,14.6 15.5,20.5 9,20.5'),
        ...halves(ngon(17.4, 8.2, 2.9, 6, 0)),
        f('16.4,13.1 19.6,12.6 22,14.6 22.5,19.5 16.9,19.5'),
    ],
    shield: fan([12, 10.5], parse('12,2 20.5,5 19.6,12.8 12,22 4.4,12.8 3.5,5')),
    radar: [
        ...ring(12, 12, 10, 8, 8, -67.5),
        ...halves(ngon(12, 12, 3, 6, 0)),
        f('12,12 13.7,4.2 19,7.4'),
    ],
    qr: [
        ...ring(6.5, 6.5, 5.66, 2.83, 4, 45),
        ...ring(17.5, 6.5, 5.66, 2.83, 4, 45),
        ...ring(6.5, 17.5, 5.66, 2.83, 4, 45),
        ...rect(5.4, 5.4, 7.6, 7.6),
        ...rect(16.4, 5.4, 18.6, 7.6),
        ...rect(5.4, 16.4, 7.6, 18.6),
        ...rect(13, 13, 15.8, 15.8),
        ...rect(18.2, 13, 21, 15.8),
        ...rect(15.6, 18.2, 18.4, 21),
    ],
    megaphone: [
        ...rect(3.5, 9, 10, 15),
        f('10,9 19.5,3.5 19.5,12'),
        f('10,9 19.5,12 10,15'),
        f('10,15 19.5,12 19.5,20.5'),
        f('5.5,15.8 9.5,15.8 10.6,20.8 7.4,20.8'),
    ],
    logout: [
        f('3.5,3 6.5,6 6.5,18 3.5,21'),
        f('3.5,3 13,3 13,6 6.5,6'),
        f('6.5,18 13,18 13,21 3.5,21'),
        f('15,6.8 21,12 15,12'),
        f('15,12 21,12 15,17.2'),
        f('9,10.5 15,10.5 15,13.5 9,13.5'),
    ],
    pin: [
        ...fan([12, 9.5], parse('12,22.5 5,11.5 5.6,6.4 9,3 15,3 18.4,6.4 19,11.5')),
        ...halves(ngon(12, 9.5, 2.6, 6, 0), true),
    ],
    check: [f('2.5,12.6 5.6,9.6 9.6,13.6 9.6,19.6'), f('9.6,13.6 18.4,4.8 21.5,7.8 9.6,19.6')],
    alert: [
        ...fan([12, 14.5], parse('12,2.5 22.5,20.8 1.5,20.8')),
        cut('11,8.5 13,8.5 12.6,14.6 11.4,14.6'),
        cut('12,16.2 13.3,17.5 12,18.8 10.7,17.5'),
    ],
    target: [...ring(12, 12, 10, 7.8, 8, -67.5), ...fan([12, 12], ngon(12, 12, 4.2, 4))],
    home: [
        f('12,2.5 12,11 2,11'),
        f('12,2.5 22,11 12,11'),
        ...rect(5, 11, 19, 21.5),
        cut('10,14.5 14,14.5 14,21.5 10,21.5'),
    ],
    eye: [
        ...fan([12, 12], parse('1.5,12 7.5,5.8 16.5,5.8 22.5,12 16.5,18.2 7.5,18.2')),
        ...halves(ngon(12, 12, 3.2, 6, 0), true),
    ],
    edit: [
        f('6.2,14.3 15.6,4.9 19.1,8.4'),
        f('6.2,14.3 19.1,8.4 9.7,17.8'),
        f('4.5,19.5 6.2,14.3 9.7,17.8'),
    ],
    trash: [
        ...rect(3.5, 5, 20.5, 7.5),
        f('9,2.5 15,2.5 15.5,4.5 8.5,4.5'),
        f('5,9 19,9 17.5,21.5'),
        f('5,9 17.5,21.5 6.5,21.5'),
    ],
    phone: [
        ...rect(6, 1.8, 18, 22.2),
        cut('7.8,4.5 16.2,4.5 16.2,17.8 7.8,17.8'),
        cut('11,19.2 13,19.2 12,20.8'),
    ],
    mail: [
        f('3,5.5 21,5.5 12,13'),
        f('3,5.5 12,13 3,18.5'),
        f('21,5.5 21,18.5 12,13'),
        f('3,18.5 12,13 21,18.5'),
    ],
    lock: [
        ...rect(5, 10.5, 19, 21.5),
        f(
            '7.5,10.5 7.5,7 9.7,3.5 14.3,3.5 16.5,7 16.5,10.5 14,10.5 14,7.6 13,6 11,6 10,7.6 10,10.5',
        ),
        cut('11,14 13,14 12.6,18.5 11.4,18.5'),
    ],
    route: [
        ...halves(ngon(5, 18.6, 3, 6, 0)),
        ...halves(ngon(19, 5.4, 3, 6, 0)),
        f('6.6,16.2 11.6,13.4 12.6,15 7.6,17.8'),
        f('11.6,13.4 12.6,15 13.6,10.4 12.4,9.4'),
        f('12.4,9.4 13.6,10.4 17.6,7.6 16.6,6.2'),
    ],
    grid: [
        ...rect(3, 3, 10.8, 10.8),
        ...rect(13.2, 3, 21, 10.8),
        ...rect(3, 13.2, 10.8, 21),
        ...rect(13.2, 13.2, 21, 21),
    ],
    filter: [f('3,4 21,4 14,12.4'), f('3,4 14,12.4 10,12.4'), f('10,12.4 14,12.4 14,20 10,18')],
    settings: [
        ...fan([12, 12], star(12, 12, 10.2, 7.6, 8)),
        ...halves(ngon(12, 12, 3.2, 6, 0), true),
    ],
    refresh: [...ring(12, 12, 9.5, 6.9, 8, -67.5, [7]), f('12.4,0.8 18.6,4.6 12.4,7.8')],
    tree: [
        f('12,1.8 12,9 6.5,9'),
        f('12,1.8 17.5,9 12,9'),
        f('12,6.5 12,15.5 4.5,15.5'),
        f('12,6.5 19.5,15.5 12,15.5'),
        ...rect(10.4, 15.5, 13.6, 22),
    ],
    info: [
        ...fan([12, 12], ngon(12, 12, 10.5, 8, -67.5)),
        cut('10.9,10.2 13.1,10.2 13.1,17.6 10.9,17.6'),
        cut('12,5.8 13.4,7.2 12,8.6 10.6,7.2'),
    ],
    mic: [
        f('9,4.5 12,2 12,14.5 9,12'),
        f('12,2 15,4.5 15,12 12,14.5'),
        f(
            '5.5,10.5 7.5,10.5 7.5,12 12,16.5 16.5,12 16.5,10.5 18.5,10.5 18.5,12.8 13,18.2 13,20 16,20 16,22 8,22 8,20 11,20 11,18.2 5.5,12.8',
        ),
    ],
    battery: [...rect(2.5, 7, 19.5, 17), f('19.5,10 21.5,10 21.5,14 19.5,14')],
    signal: [
        ...rect(3, 16, 6.5, 21),
        ...rect(8.5, 12, 12, 21),
        ...rect(14, 7.5, 17.5, 21),
        ...rect(19.5, 3, 23, 21),
    ],
    camera: [
        ...fan([12, 13], parse('3,7 7.5,7 9,4.5 15,4.5 16.5,7 21,7 21,19.5 3,19.5')),
        ...halves(ngon(12, 13, 3.6, 6, 0), true),
    ],
    user: [
        ...halves(ngon(12, 7.4, 4.4, 6, 0)),
        f('4,21.5 5.4,15.2 12,13 12,21.5'),
        f('12,13 18.6,15.2 20,21.5 12,21.5'),
    ],
    undo: [
        f('2.5,9 9.5,3.2 9.5,14.8'),
        f(
            '9.5,7.4 15,7.4 19.6,10.6 21,15.6 18.6,20.6 15.4,20.6 17.8,15.8 17,12.4 14.2,10.6 9.5,10.6',
        ),
    ],
    live: [
        ...fan([12, 12], ngon(12, 12, 4.5, 6, 0)),
        ...ring(12, 12, 10.5, 8.3, 8, -67.5, [1, 2, 5, 6]),
    ],
} satisfies Record<string, Facet[]>;

export type GlyphName = keyof typeof GLYPHS;

export interface SvgOptions {
    size: number;
    fill: string;
    /** Seam color: the background the icon sits on. */
    seam: string;
    seamWidth?: number;
    /** Optional badge behind the glyph, as in the app icon. */
    badge?: { shape: 'square' | 'circle'; fill: string; stroke?: string };
    rotateDeg?: number;
    opacity?: number;
    /** No seams: facets merge into one silhouette and corners round off (map badges). */
    smooth?: boolean;
}

/** A glyph as a standalone SVG string (map billboards, favicons). */
export function glyphSvg(name: GlyphName, o: SvgOptions): string {
    const badge = o.badge;
    const inset = badge ? 5 : 0;
    const scale = (24 - inset * 2) / 24;
    const hole = o.smooth ? (badge?.fill ?? o.seam) : o.seam;
    const line = o.smooth ? o.fill : o.seam;
    const facets = GLYPHS[name]
        .map((x) =>
            x.cut && o.smooth
                ? `<polygon points="${x.points}" fill="${hole}" stroke="${hole}"/>`
                : `<polygon points="${x.points}" fill="${x.cut ? o.seam : o.fill}"/>`,
        )
        .join('');
    const badgeShape = !badge
        ? ''
        : badge.shape === 'circle'
          ? `<circle cx="12" cy="12" r="11.2" fill="${badge.fill}" stroke="${badge.stroke ?? 'none'}" stroke-width="1"/>`
          : `<rect x="0.8" y="0.8" width="22.4" height="22.4" rx="6" fill="${badge.fill}" stroke="${badge.stroke ?? 'none'}" stroke-width="1"/>`;
    const rotate = o.rotateDeg ? ` rotate(${o.rotateDeg} 12 12)` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 24 24" opacity="${o.opacity ?? 1}">${badgeShape}<g transform="translate(${inset} ${inset}) scale(${scale})${rotate}" stroke="${line}" stroke-width="${o.seamWidth ?? 0.9}" stroke-linejoin="round">${facets}</g></svg>`;
}
