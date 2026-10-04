import type { ForestFitResult, LatLng } from '@ember/contracts';
import { boundsOf, growBounds, polygonAreaM2, projection, simplifyRing, sizeM } from './geo.js';
import type { Bounds, Point } from './geo.js';
import { elementRings } from './osm.js';
import type { OsmElement } from './osm.js';
import type { Overpass } from './overpass.js';
import {
    Mask,
    close,
    fillHoles,
    fillRings,
    largestComponent,
    makeGrid,
    reach,
    traceOutline,
} from './raster.js';
import type { Grid } from './raster.js';
import type { OpenData } from './types.js';

// Grass and scrub carry fire as readily as trees, so they count as forest here.
const VEGETATION = {
    landuse: ['forest', 'meadow', 'grass', 'orchard'],
    natural: ['wood', 'scrub', 'grassland', 'heath', 'fell'],
} as const;

const MIN_MARGIN_M = 300;
const MARGIN_SHARE = 0.3;
const MIN_SEED_SHARE = 0.05;
const MAX_POINTS = 80;

function forestQuery(area: Bounds): string {
    const box = `(${area.south.toFixed(6)},${area.west.toFixed(6)},${area.north.toFixed(6)},${area.east.toFixed(6)})`;
    const statements = Object.entries(VEGETATION).flatMap(([key, values]) =>
        ['way', 'relation'].map((type) => `  ${type}["${key}"~"^(${values.join('|')})$"]${box};`),
    );
    return ['(', ...statements, ');', 'out geom;'].join('\n');
}

function vegetationTags(element: OsmElement): string[] {
    const tags: string[] = [];
    for (const [key, values] of Object.entries(VEGETATION)) {
        const value = element.tags[key];
        if (value !== undefined && (values as readonly string[]).includes(value)) {
            tags.push(`${key}=${value}`);
        }
    }
    return tags;
}

type Feature = { tags: string[]; rings: Point[][] };

function features(elements: readonly OsmElement[], toLocal: (at: LatLng) => Point): Feature[] {
    const found: Feature[] = [];
    for (const element of elements) {
        const tags = vegetationTags(element);
        if (tags.length === 0) continue;
        const { outer, inner } = elementRings(element);
        const rings = [...outer, ...inner].map((ring) => ring.map((at) => toLocal(at)));
        if (rings.length > 0) found.push({ tags, rings });
    }
    return found;
}

function outlineMask(grid: Grid, outline: Point[]): Mask {
    const mask = new Mask(grid.cols, grid.rows);
    fillRings(grid, [outline], (cell) => {
        mask.data[cell] = 1;
    });
    if (mask.count() > 0) return mask;
    // An outline smaller than a cell still counts as the cell under its centre.
    const n = Math.max(1, outline.length);
    const x = outline.reduce((sum, p) => sum + p.x, 0) / n;
    const y = outline.reduce((sum, p) => sum + p.y, 0) / n;
    const i = Math.floor((x - grid.minX) / grid.cell);
    const j = Math.floor((y - grid.minY) / grid.cell);
    if (i >= 0 && j >= 0 && i < grid.cols && j < grid.rows) mask.data[j * grid.cols + i] = 1;
    return mask;
}

function limitPoints(corners: Point[], cell: number): Point[] {
    let tolerance = 1.5 * cell;
    let ring = simplifyRing(corners, tolerance);
    while (ring.length < 3 && tolerance > 0.01) {
        tolerance /= 2;
        ring = simplifyRing(corners, tolerance);
    }
    if (ring.length < 3) return corners;
    while (ring.length > MAX_POINTS) {
        tolerance *= 1.4;
        const next = simplifyRing(corners, tolerance);
        if (next.length < 3) break;
        ring = next;
    }
    if (ring.length <= MAX_POINTS) return ring;
    const step = Math.ceil(ring.length / MAX_POINTS);
    return ring.filter((_, k) => k % step === 0);
}

/** The vegetated land around the drawn outline as one ring, or null when the outline holds none. */
function fitToVegetation(
    boundary: readonly LatLng[],
    area: Bounds,
    elements: readonly OsmElement[],
): ForestFitResult | null {
    const { toLocal, toLatLng } = projection({
        lat: (area.south + area.north) / 2,
        lng: (area.west + area.east) / 2,
    });
    const { widthM, heightM } = sizeM(area);
    const grid = makeGrid(widthM, heightM);
    const found = features(elements, toLocal);

    const vegetated = new Mask(grid.cols, grid.rows);
    for (const feature of found) {
        fillRings(grid, feature.rings, (cell) => {
            vegetated.data[cell] = 1;
        });
    }

    const drawn = outlineMask(
        grid,
        boundary.map((at) => toLocal(at)),
    );
    const drawnCells = drawn.indices();
    const seeds = drawnCells.filter((cell) => vegetated.data[cell] === 1);
    if (seeds.length === 0 || seeds.length < MIN_SEED_SHARE * drawnCells.length) return null;

    const selected = largestComponent(fillHoles(close(reach(vegetated, seeds))));
    const corners = traceOutline(selected).map((c) => ({
        x: grid.minX + c.x * grid.cell,
        y: grid.minY + c.y * grid.cell,
    }));
    if (corners.length < 3) return null;
    const ring = limitPoints(corners, grid.cell);

    const classes = new Set<string>();
    for (const feature of found) {
        let touched = false;
        fillRings(grid, feature.rings, (cell) => {
            if (selected.data[cell] === 1) touched = true;
        });
        if (touched) for (const tag of feature.tags) classes.add(tag);
    }

    return {
        boundary: ring.map((at) => toLatLng(at)),
        areaM2: Math.round(polygonAreaM2(ring)),
        vegetatedShare: Math.round((seeds.length / drawnCells.length) * 1000) / 1000,
        classes: [...classes].toSorted(),
        source: 'openstreetmap',
    };
}

export function createForestFit(overpass: Overpass): OpenData['fitForest'] {
    return async (boundary) => {
        const drawn = boundsOf(boundary);
        const { widthM, heightM } = sizeM(drawn);
        const area = growBounds(
            drawn,
            Math.max(MARGIN_SHARE * heightM, MIN_MARGIN_M),
            Math.max(MARGIN_SHARE * widthM, MIN_MARGIN_M),
        );
        return fitToVegetation(boundary, area, await overpass(forestQuery(area)));
    };
}
