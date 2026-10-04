import { expect, test } from 'vitest';
import type { LatLng } from '@ember/contracts';
import { createOpenData } from './index.js';

const boundary: LatLng[] = [
    { lat: 20.878, lng: -156.658 },
    { lat: 20.878, lng: -156.652 },
    { lat: 20.872, lng: -156.652 },
    { lat: 20.872, lng: -156.658 },
];

type Tags = Record<string, string>;
type Corner = [number, number];

const node = (id: number, lat: number, lon: number, tags: Tags) => ({
    type: 'node',
    id,
    lat,
    lon,
    tags,
});
const way = (id: number, tags: Tags, corners: Corner[]) => ({
    type: 'way',
    id,
    tags,
    geometry: corners.map(([lat, lon]) => ({ lat, lon })),
});
const centred = (type: string, id: number, tags: Tags, lat: number, lon: number) => ({
    type,
    id,
    tags,
    center: { lat, lon },
});
const box = (lat: number, lon: number, half: number): Corner[] => [
    [lat - half, lon - half],
    [lat - half, lon + half],
    [lat + half, lon + half],
    [lat + half, lon - half],
    [lat - half, lon - half],
];

function surroundingsOf(elements: unknown[]) {
    const requests: string[] = [];
    const data = createOpenData({
        fetch: async (_input, init) => {
            requests.push(new URLSearchParams(String(init?.body)).get('data') ?? '');
            return Response.json({ elements });
        },
    });
    return { run: () => data.surroundings(boundary), requests };
}

test('one query asks for roads, places, residential land, safe zones and stations', async () => {
    const { run, requests } = surroundingsOf([]);
    const result = await run();

    expect(result).toEqual({
        source: 'openstreetmap',
        civilianAreas: [],
        roads: [],
        safeZones: [],
        stations: [],
    });
    expect(requests).toHaveLength(1);
    const query = requests[0] ?? '';
    expect(query).toContain('"highway"~"^(motorway|motorway_link|trunk');
    expect(query).toContain('"place"~"^(city|town|suburb|village|neighbourhood|quarter|hamlet');
    expect(query).toContain('"landuse"="residential"');
    expect(query).toContain('"emergency"="assembly_point"');
    expect(query).toContain('"social_facility"="shelter"');
    expect(query).toContain('fire_station|ranger_station');
    expect(query).toContain('out geom;');
    expect(query).toContain('out center;');
});

test('places become civilian areas with the smallest residential polygon around them', async () => {
    const { run } = surroundingsOf([
        node(1, 20.9, -156.7, { place: 'town', name: 'Lahaina' }),
        way(10, { landuse: 'residential' }, box(20.9, -156.7, 0.01)),
        way(11, { landuse: 'residential' }, box(20.9, -156.7, 0.002)),
        way(12, { landuse: 'residential' }, box(20.95, -156.7, 0.002)),
        node(2, 20.91, -156.71, { place: 'village', name: 'Kaanapali', population: '2,500' }),
        node(3, 20.92, -156.72, { place: 'hamlet', name: 'Tiny' }),
        node(4, 20.93, -156.73, { place: 'village' }),
        node(5, 20.94, -156.74, { place: 'city', name: 'Kahului', population: 'many' }),
        node(6, 20.95, -156.75, { place: 'suburb', name: 'Hillside' }),
        node(7, 20.96, -156.76, { place: 'island', name: 'Not a settlement' }),
    ]);
    const { civilianAreas } = await run();

    expect(civilianAreas.map((a) => [a.id, a.population])).toEqual([
        ['osm-node-5', 50000],
        ['osm-node-1', 8000],
        ['osm-node-6', 5000],
        ['osm-node-2', 2500],
        ['osm-node-3', 150],
    ]);
    const lahaina = civilianAreas.find((a) => a.name === 'Lahaina');
    expect(lahaina?.center).toEqual({ lat: 20.9, lng: -156.7 });
    expect(lahaina?.polygon).toHaveLength(4);
    expect(lahaina?.polygon?.every((p) => Math.abs(p.lat - 20.9) <= 0.0021)).toBe(true);
    expect(civilianAreas.find((a) => a.name === 'Tiny')?.polygon).toBeNull();
});

test('a multipolygon residential relation gives its outer ring', async () => {
    const outer = box(20.9, -156.7, 0.003);
    const { run } = surroundingsOf([
        node(1, 20.9, -156.7, { place: 'village', name: 'Pukalani' }),
        {
            type: 'relation',
            id: 50,
            tags: { type: 'multipolygon', landuse: 'residential' },
            members: [
                {
                    type: 'way',
                    ref: 1,
                    role: 'outer',
                    geometry: outer.slice(0, 3).map(([lat, lon]) => ({ lat, lon })),
                },
                {
                    type: 'way',
                    ref: 2,
                    role: 'outer',
                    geometry: outer.slice(2).map(([lat, lon]) => ({ lat, lon })),
                },
            ],
        },
    ]);
    const { civilianAreas } = await run();
    expect(civilianAreas[0]?.polygon).toHaveLength(4);
});

test('highways map to road kinds and anything else is ignored', async () => {
    const line: Corner[] = [
        [20.8, -156.6],
        [20.81, -156.61],
    ];
    const kinds = [
        'motorway',
        'motorway_link',
        'trunk',
        'primary_link',
        'secondary',
        'tertiary_link',
        'unclassified',
        'residential',
        'track',
        'footway',
        'service',
    ];
    const { run } = surroundingsOf([
        ...kinds.map((highway, k) => way(100 + k, { highway }, line)),
        way(200, { highway: 'residential', name: 'Front Street' }, line),
        way(201, { highway: 'residential' }, [[20.8, -156.6]]),
        way(202, { building: 'yes' }, line),
    ]);
    const { roads } = await run();

    expect(roads.map((r) => [r.id, r.kind])).toEqual([
        ['osm-way-100', 'motorway'],
        ['osm-way-101', 'motorway'],
        ['osm-way-102', 'primary'],
        ['osm-way-103', 'primary'],
        ['osm-way-104', 'secondary'],
        ['osm-way-105', 'secondary'],
        ['osm-way-106', 'secondary'],
        ['osm-way-107', 'residential'],
        ['osm-way-200', 'residential'],
        ['osm-way-108', 'track'],
    ]);
    expect(roads.find((r) => r.id === 'osm-way-200')?.name).toBe('Front Street');
    expect(roads[0]?.name).toBeNull();
    expect(roads[0]?.path).toEqual([
        { lat: 20.8, lng: -156.6 },
        { lat: 20.81, lng: -156.61 },
    ]);
});

test('safe zones inside the boundary are dropped and the rest ranked', async () => {
    const { run } = surroundingsOf([
        centred('way', 300, { amenity: 'school', name: 'Inside School' }, 20.875, -156.655),
        node(301, 20.88, -156.64, { amenity: 'school', name: 'Far School' }),
        node(302, 20.8805, -156.65, { amenity: 'school', name: 'Near School' }),
        node(303, 20.89, -156.65, { amenity: 'hospital' }),
        centred(
            'way',
            304,
            { amenity: 'community_centre', name: 'Hall', capacity: '120' },
            20.9,
            -156.6,
        ),
        node(305, 20.95, -156.6, { emergency: 'assembly_point' }),
        node(306, 20.99, -156.6, { amenity: 'shelter', name: 'Far Shelter' }),
        node(307, 20.96, -156.6, { social_facility: 'shelter' }),
        node(308, 20.875, -156.655, { emergency: 'assembly_point', name: 'Inside Point' }),
        centred('relation', 309, { amenity: 'townhall' }, 20.97, -156.6),
    ]);
    const { safeZones } = await run();

    expect(safeZones.map((z) => z.id)).toEqual([
        'osm-node-305',
        'osm-node-307',
        'osm-node-306',
        'osm-node-302',
        'osm-node-301',
        'osm-way-304',
        'osm-node-303',
        'osm-relation-309',
    ]);
    const byId = new Map(safeZones.map((z) => [z.id, z]));
    expect(byId.get('osm-node-305')?.name).toBe('Assembly point');
    expect(byId.get('osm-node-307')?.name).toBe('Shelter');
    expect(byId.get('osm-node-306')?.name).toBe('Far Shelter');
    expect(byId.get('osm-node-303')?.name).toBe('Hospital');
    expect(byId.get('osm-relation-309')?.name).toBe('Town hall');
    expect(byId.get('osm-way-304')).toMatchObject({
        location: { lat: 20.9, lng: -156.6 },
        capacity: 120,
    });
    expect(byId.get('osm-node-302')?.capacity).toBeNull();
});

test('stations are named, labelled by type and sorted nearest first', async () => {
    const { run } = surroundingsOf([
        node(400, 20.95, -156.65, { amenity: 'fire_station', name: 'Far Station' }),
        centred('way', 401, { amenity: 'fire_station' }, 20.88, -156.65),
        node(402, 20.9, -156.65, { amenity: 'ranger_station' }),
        node(403, 20.89, -156.65, { amenity: 'ranger_station', name: 'Ridge Post' }),
        node(404, 20.89, -156.65, { amenity: 'school' }),
    ]);
    const { stations } = await run();

    expect(stations.map((s) => [s.id, s.name])).toEqual([
        ['osm-way-401', 'Fire station'],
        ['osm-node-403', 'Ridge Post'],
        ['osm-node-402', 'Ranger station'],
        ['osm-node-400', 'Far Station'],
    ]);
    expect(stations[0]?.location).toEqual({ lat: 20.88, lng: -156.65 });
});

test('results are capped, keeping the most important', async () => {
    const line: Corner[] = [
        [20.8, -156.6],
        [20.81, -156.61],
    ];
    const elements: unknown[] = [];
    for (let k = 0; k < 70; k++) {
        elements.push(
            node(1000 + k, 20.9, -156.7 + k * 0.001, {
                place: 'hamlet',
                name: `Hamlet ${k}`,
                population: String(100 + k),
            }),
        );
    }
    for (let k = 0; k < 6100; k++) elements.push(way(2000 + k, { highway: 'residential' }, line));
    for (let k = 0; k < 20; k++) elements.push(way(9000 + k, { highway: 'motorway' }, line));
    for (let k = 0; k < 80; k++) {
        elements.push(
            node(5000 + k, 20.9 + k * 0.001, -156.6, { amenity: 'school', name: `S${k}` }),
        );
    }
    for (let k = 0; k < 40; k++) {
        elements.push(node(6000 + k, 20.9 + k * 0.001, -156.5, { amenity: 'fire_station' }));
    }
    const { run } = surroundingsOf(elements);
    const result = await run();

    expect(result.civilianAreas).toHaveLength(60);
    expect(result.civilianAreas[0]?.population).toBe(169);
    expect(result.roads).toHaveLength(6000);
    expect(result.roads.filter((r) => r.kind === 'motorway')).toHaveLength(20);
    expect(result.safeZones).toHaveLength(40);
    expect(result.safeZones[0]?.id).toBe('osm-node-5000');
    expect(result.stations).toHaveLength(30);
    expect(result.stations[0]?.id).toBe('osm-node-6000');
});
