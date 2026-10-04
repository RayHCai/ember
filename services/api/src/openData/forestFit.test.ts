import { expect, test } from 'vitest';
import type { LatLng } from '@ember/contracts';
import { createOpenData } from './index.js';

type Corner = [number, number];

const wire = (corners: Corner[]) => corners.map(([lat, lon]) => ({ lat, lon }));
const rectangle = (south: number, west: number, north: number, east: number): Corner[] => [
    [south, west],
    [south, east],
    [north, east],
    [north, west],
    [south, west],
];
const ring = (south: number, west: number, north: number, east: number): LatLng[] => [
    { lat: north, lng: west },
    { lat: north, lng: east },
    { lat: south, lng: east },
    { lat: south, lng: west },
];

const METRES_PER_DEGREE = 111_195;
const forestAreaM2 = 0.01 * METRES_PER_DEGREE * 0.01 * METRES_PER_DEGREE * Math.cos(0.3643);

const forest = {
    type: 'way',
    id: 1,
    tags: { landuse: 'forest' },
    geometry: wire(rectangle(20.87, -156.66, 20.88, -156.65)),
};
const roughSquare = ring(20.872, -156.658, 20.878, -156.652);

function openDataReturning(elements: unknown[]) {
    const requests: string[] = [];
    const data = createOpenData({
        fetch: async (_input, init) => {
            requests.push(String(init?.body));
            return Response.json({ elements });
        },
    });
    return { data, requests };
}

test('a rough square inside a forest snaps to the whole forest', async () => {
    const { data, requests } = openDataReturning([forest]);
    const fit = await data.fitForest(roughSquare);

    expect(fit).not.toBeNull();
    expect(fit?.source).toBe('openstreetmap');
    expect(fit?.classes).toEqual(['landuse=forest']);
    expect(fit?.vegetatedShare).toBeGreaterThan(0.99);
    expect(fit?.areaM2).toBeGreaterThan(forestAreaM2 * 0.9);
    expect(fit?.areaM2).toBeLessThan(forestAreaM2 * 1.1);

    const points = fit?.boundary ?? [];
    expect(points.length).toBeGreaterThanOrEqual(3);
    expect(points.length).toBeLessThanOrEqual(80);
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    expect(Math.min(...lats)).toBeLessThan(20.872);
    expect(Math.max(...lats)).toBeGreaterThan(20.878);
    expect(Math.min(...lngs)).toBeLessThan(-156.658);
    expect(Math.max(...lngs)).toBeGreaterThan(-156.652);

    const query = new URLSearchParams(requests[0]).get('data') ?? '';
    expect(query).toContain('"landuse"~"^(forest|meadow|grass|orchard)$"');
    expect(query).toContain('"natural"~"^(wood|scrub|grassland|heath|fell)$"');
    expect(query).toContain('relation');
    expect(query).toContain('out geom;');
});

test('grassland counts as fuel and the classes list every tag that touched', async () => {
    const grass = {
        type: 'way',
        id: 2,
        tags: { natural: 'grassland' },
        geometry: wire(rectangle(20.87, -156.66, 20.88, -156.65)),
    };
    const elsewhere = {
        type: 'way',
        id: 3,
        tags: { landuse: 'orchard' },
        geometry: wire(rectangle(20.8, -156.5, 20.801, -156.499)),
    };
    const water = { type: 'way', id: 4, tags: { natural: 'water' }, geometry: forest.geometry };
    const { data } = openDataReturning([grass, elsewhere, water]);
    const fit = await data.fitForest(roughSquare);

    expect(fit?.classes).toEqual(['natural=grassland']);
});

test('a multipolygon with a hole fits its outer ring and reports the hole as unvegetated', async () => {
    const hole: Corner[] = rectangle(20.874, -156.656, 20.876, -156.654);
    const relation = {
        type: 'relation',
        id: 9,
        tags: { type: 'multipolygon', natural: 'wood' },
        members: [
            {
                type: 'way',
                ref: 1,
                role: 'outer',
                geometry: wire([
                    [20.87, -156.66],
                    [20.87, -156.65],
                    [20.88, -156.65],
                ]),
            },
            {
                type: 'way',
                ref: 2,
                role: 'outer',
                geometry: wire([
                    [20.87, -156.66],
                    [20.88, -156.66],
                    [20.88, -156.65],
                ]),
            },
            { type: 'way', ref: 3, role: 'inner', geometry: wire(hole) },
        ],
    };
    const { data } = openDataReturning([relation]);
    const fit = await data.fitForest(roughSquare);

    expect(fit?.classes).toEqual(['natural=wood']);
    expect(fit?.vegetatedShare).toBeGreaterThan(0.85);
    expect(fit?.vegetatedShare).toBeLessThan(0.93);
    expect(fit?.areaM2).toBeGreaterThan(forestAreaM2 * 0.9);
    expect(fit?.areaM2).toBeLessThan(forestAreaM2 * 1.1);
});

test('an outline half outside an L-shaped forest fits the L', async () => {
    const lShape = {
        type: 'way',
        id: 5,
        tags: { landuse: 'forest' },
        geometry: wire([
            [20.87, -156.66],
            [20.87, -156.65],
            [20.874, -156.65],
            [20.874, -156.656],
            [20.88, -156.656],
            [20.88, -156.66],
            [20.87, -156.66],
        ]),
    };
    const { data } = openDataReturning([lShape]);
    const fit = await data.fitForest(ring(20.871, -156.659, 20.879, -156.652));

    const lArea =
        (0.01 * 0.004 + 0.006 * 0.004) * METRES_PER_DEGREE * METRES_PER_DEGREE * Math.cos(0.3643);
    expect(fit?.areaM2).toBeGreaterThan(lArea * 0.9);
    expect(fit?.areaM2).toBeLessThan(lArea * 1.1);
    expect(fit?.vegetatedShare).toBeGreaterThan(0.5);
    expect(fit?.vegetatedShare).toBeLessThan(0.8);
    expect(fit?.boundary.length).toBeLessThanOrEqual(8);
});

test('no vegetation is null', async () => {
    const { data } = openDataReturning([]);
    expect(await data.fitForest(roughSquare)).toBeNull();
});

test('vegetation nowhere near the outline is null', async () => {
    const strip = {
        type: 'way',
        id: 6,
        tags: { landuse: 'forest' },
        geometry: wire(rectangle(20.879, -156.658, 20.8805, -156.652)),
    };
    const { data } = openDataReturning([strip]);
    expect(await data.fitForest(roughSquare)).toBeNull();
});

test('vegetation under a sliver of the outline is null', async () => {
    const sliver = {
        type: 'way',
        id: 7,
        tags: { landuse: 'forest' },
        geometry: wire(rectangle(20.8778, -156.67, 20.88, -156.64)),
    };
    const { data } = openDataReturning([sliver]);
    expect(await data.fitForest(roughSquare)).toBeNull();
});

test('a ragged forest edge is simplified to at most 80 points', async () => {
    const lngScale = METRES_PER_DEGREE * Math.cos(0.3643);
    const ragged: Corner[] = [];
    for (let k = 0; k < 400; k++) {
        const angle = (k / 400) * 2 * Math.PI;
        const radiusM = 450 + (k % 20 < 10 ? 25 : -25);
        ragged.push([
            20.875 + (radiusM * Math.sin(angle)) / METRES_PER_DEGREE,
            -156.655 + (radiusM * Math.cos(angle)) / lngScale,
        ]);
    }
    ragged.push(ragged[0]!);
    const wood = { type: 'way', id: 8, tags: { natural: 'wood' }, geometry: wire(ragged) };
    const { data } = openDataReturning([wood]);
    const fit = await data.fitForest(roughSquare);

    expect(fit?.boundary.length).toBeGreaterThanOrEqual(3);
    expect(fit?.boundary.length).toBeLessThanOrEqual(80);
    expect(fit?.areaM2).toBeGreaterThan(Math.PI * 450 * 450 * 0.85);
    expect(fit?.areaM2).toBeLessThan(Math.PI * 450 * 450 * 1.15);
});
