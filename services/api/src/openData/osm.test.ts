import { expect, test } from 'vitest';
import { assembleRings, elementRings, parseElements } from './osm.js';

const SW = { lat: 20.87, lng: -156.66 };
const SE = { lat: 20.87, lng: -156.65 };
const NE = { lat: 20.88, lng: -156.65 };
const NW = { lat: 20.88, lng: -156.66 };
const wire = (points: { lat: number; lng: number }[]) =>
    points.map(({ lat, lng }) => ({ lat, lon: lng }));

test('a multipolygon split into reversed outer ways and a hole assembles into two rings', () => {
    const hole = [
        { lat: 20.874, lng: -156.656 },
        { lat: 20.874, lng: -156.654 },
        { lat: 20.876, lng: -156.654 },
        { lat: 20.876, lng: -156.656 },
        { lat: 20.874, lng: -156.656 },
    ];
    const [relation] = parseElements([
        {
            type: 'relation',
            id: 7,
            tags: { type: 'multipolygon', natural: 'wood' },
            members: [
                { type: 'way', ref: 1, role: 'outer', geometry: wire([SW, SE, NE]) },
                { type: 'way', ref: 2, role: 'outer', geometry: wire([SW, NW, NE]) },
                { type: 'way', ref: 3, role: 'inner', geometry: wire(hole) },
                { type: 'node', ref: 4, role: 'label', lat: 20.875, lon: -156.655 },
            ],
        },
    ]);
    expect(relation).toBeDefined();
    const { outer, inner } = elementRings(relation!);

    expect(outer).toHaveLength(1);
    expect(outer[0]).toHaveLength(4);
    expect(outer[0]).toEqual(expect.arrayContaining([SW, SE, NE, NW]));
    expect(inner).toHaveLength(1);
    expect(inner[0]).toHaveLength(4);
});

test('assembleRings joins three pieces in any direction and drops chains that never close', () => {
    const rings = assembleRings([
        [SE, NE],
        [SW, SE],
        [SW, NW, NE].toReversed(),
        [
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
        ],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
});

test('a closed way is one ring and an open way has none', () => {
    const [closed, open] = parseElements([
        { type: 'way', id: 1, tags: {}, geometry: wire([SW, SE, NE, NW, SW]) },
        { type: 'way', id: 2, tags: {}, geometry: wire([SW, SE, NE]) },
    ]);
    expect(elementRings(closed!).outer).toHaveLength(1);
    expect(elementRings(open!).outer).toEqual([]);
});

test('parseElements skips malformed elements and keeps centres', () => {
    const elements = parseElements([
        null,
        'x',
        { type: 'node', id: 1, lat: 20.1, lon: -156.1, tags: { name: 'A', bad: 3 } },
        { type: 'node', id: 'two' },
        { type: 'area', id: 3 },
        { type: 'way', id: 4, center: { lat: 20.2, lon: -156.2 }, tags: { amenity: 'school' } },
    ]);
    expect(elements.map((e) => e.id)).toEqual([1, 4]);
    expect(elements[0]?.tags).toEqual({ name: 'A' });
    expect(elements[1]?.point).toEqual({ lat: 20.2, lng: -156.2 });
});
