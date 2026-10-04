import { expect, test, vi } from 'vitest';
import type { ForestFitResult } from '@ember/contracts';
import { buildApp } from '../app.js';
import { newSession } from '../auth.js';
import type { Db } from '../db.js';
import { OpenDataError, type OpenData } from '../openData/types.js';

type Stub = (...args: never[]) => unknown;
type Data = Record<string, unknown>;

const zoneId = '00000000-0000-4000-8000-000000000001';
const operatorId = '00000000-0000-4000-8000-0000000000a1';
const now = new Date('2026-10-04T12:00:00Z');
const boundary = [
    { lat: 20.87, lng: -156.69 },
    { lat: 20.87, lng: -156.67 },
    { lat: 20.89, lng: -156.67 },
    { lat: 20.89, lng: -156.69 },
];
const zoneRow = {
    id: zoneId,
    name: 'Lahaina',
    region: 'Maui, Hawaii',
    boundary,
    scanEveryHours: null,
    nextScanAt: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
};
const fetched = {
    source: 'OpenStreetMap via Overpass',
    civilianAreas: [
        { id: 'a1', name: 'Lahaina', center: boundary[0]!, polygon: null, population: 900 },
    ],
    roads: [{ id: 'r1', name: null, kind: 'track' as const, path: boundary }],
    safeZones: [],
    stations: [],
};

function openData(overrides: Partial<OpenData> = {}): OpenData {
    return {
        fitForest: vi.fn<OpenData['fitForest']>(async () => null),
        surroundings: vi.fn<OpenData['surroundings']>(async () => fetched),
        weather: vi.fn<OpenData['weather']>(async () => null),
        ...overrides,
    };
}

function surroundingsStub() {
    return {
        upsert: vi.fn<(args: { create: Data }) => Promise<unknown>>(async ({ create }) => ({
            fetchedAt: null,
            error: null,
            updatedAt: now,
            ...create,
        })),
        update: vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => data),
        findUnique: vi.fn<Stub>(async () => null),
    };
}

test('a new zone keeps its region and creator and fetches its surroundings', async () => {
    const session = newSession();
    const create = vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => ({
        ...zoneRow,
        ...data,
    }));
    const zoneSurroundings = surroundingsStub();
    const data = openData();
    const db = {
        watchZone: { create },
        zoneSurroundings,
        operatorSession: {
            findUnique: vi.fn<Stub>(async () => ({
                expiresAt: session.expiresAt,
                operator: { id: operatorId, email: 'a@example.com', name: 'Ana', createdAt: now },
            })),
        },
    } as unknown as Db;
    const res = await buildApp({ db, openData: data }).inject({
        method: 'POST',
        url: '/v1/watch-zones',
        payload: { name: 'Lahaina', boundary, region: 'Maui, Hawaii' },
        headers: { authorization: `Bearer ${session.token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
        region: 'Maui, Hawaii',
        scanEveryHours: null,
        nextScanAt: null,
    });
    expect(create.mock.calls[0]![0].data).toMatchObject({ createdBy: operatorId });
    await vi.waitFor(() =>
        expect(zoneSurroundings.update).toHaveBeenCalledWith({
            where: { zoneId },
            data: expect.objectContaining({
                status: 'ready',
                source: fetched.source,
                roads: fetched.roads,
            }),
        }),
    );
    expect(data.surroundings).toHaveBeenCalledWith(boundary);
});

test('with open data off a refresh fails with the reason, without crashing', async () => {
    const zoneSurroundings = surroundingsStub();
    const db = {
        watchZone: {
            create: vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => ({
                ...zoneRow,
                ...data,
            })),
        },
        zoneSurroundings,
    } as unknown as Db;
    await buildApp({ db }).inject({
        method: 'POST',
        url: '/v1/watch-zones',
        payload: { name: 'Lahaina', boundary },
    });
    await vi.waitFor(() =>
        expect(zoneSurroundings.update).toHaveBeenCalledWith({
            where: { zoneId },
            data: { status: 'failed', error: 'open data is off' },
        }),
    );
});

test('a repeat schedule sets the next scan; null turns it off', async () => {
    const update = vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => ({
        ...zoneRow,
        ...data,
    }));
    const app = buildApp({ db: { watchZone: { update } } as unknown as Db });
    const patch = (payload: object) =>
        app.inject({ method: 'PATCH', url: `/v1/watch-zones/${zoneId}`, payload });
    const before = Date.now();
    const on = await patch({ scanEveryHours: 6 });
    const next = Date.parse(on.json().nextScanAt);
    expect(next - before).toBeGreaterThanOrEqual(6 * 3_600_000);
    expect(next - before).toBeLessThan(6 * 3_600_000 + 60_000);
    const off = await patch({ scanEveryHours: null });
    expect(update.mock.calls[1]![0].data).toEqual({ scanEveryHours: null, nextScanAt: null });
    expect(off.json()).toMatchObject({ scanEveryHours: null, nextScanAt: null });
    const bad = await Promise.all([patch({ scanEveryHours: 0 }), patch({ scanEveryHours: 169 })]);
    expect(bad.map((r) => r.statusCode)).toEqual([400, 400]);
});

test('summaries count what each zone has, without being taken for a zone id', async () => {
    const db = {
        watchZone: { findMany: vi.fn<Stub>(async () => [zoneRow]) },
        edgeServer: {
            findMany: vi.fn<Stub>(async () => [
                { id: 'edge-a', zoneId, lat: 20.88, lng: -156.68, connectivityRadiusM: 50_000 },
            ]),
        },
        edgeServerPlacement: { findMany: vi.fn<Stub>(async () => [{ zoneId }, { zoneId }]) },
        drone: { findMany: vi.fn<Stub>(async () => [{ edgeServer: { zoneId } }]) },
        scan: {
            findMany: vi.fn<Stub>(async () => []),
            findFirst: vi.fn<Stub>(async () => null),
        },
        plannerJob: { findMany: vi.fn<Stub>(async () => [{ zoneId, updatedAt: now }]) },
        mappingRun: { findMany: vi.fn<Stub>(async () => []) },
        detectionFrame: { findMany: vi.fn<Stub>(async () => []) },
    } as unknown as Db;
    const res = await buildApp({ db }).inject({ method: 'GET', url: '/v1/watch-zones/summaries' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
        {
            id: zoneId,
            summary: {
                edgeServers: 1,
                onlineEdgeServers: 0,
                placements: 2,
                drones: 1,
                coverage: 1,
                lastScan: null,
                riskZones: { onFire: 0, atRisk: 0, onFireM2: 0, atRiskM2: 0 },
                lastPlanAt: now.toISOString(),
            },
        },
    ]);
});

test('surroundings start pending when the zone has none yet; roads can be left out', async () => {
    const zoneSurroundings = surroundingsStub();
    const db = {
        watchZone: { findUnique: vi.fn<Stub>(async () => ({ id: zoneId, boundary })) },
        zoneSurroundings,
    } as unknown as Db;
    const app = buildApp({ db, openData: openData() });
    const res = await app.inject({ method: 'GET', url: `/v1/watch-zones/${zoneId}/surroundings` });
    expect(res.json()).toEqual({
        zoneId,
        status: 'pending',
        source: '',
        fetchedAt: null,
        error: null,
        civilianAreas: [],
        roads: [],
        safeZones: [],
        stations: [],
    });
    zoneSurroundings.findUnique.mockResolvedValue({
        zoneId,
        status: 'ready',
        fetchedAt: now,
        error: null,
        updatedAt: now,
        ...fetched,
    });
    const noRoads = await app.inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}/surroundings?roads=false`,
    });
    expect(noRoads.json()).toMatchObject({
        status: 'ready',
        roads: [],
        civilianAreas: [{ id: 'a1' }],
    });
    const refresh = await app.inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/surroundings/refresh`,
    });
    expect(refresh.statusCode).toBe(202);
});

test('forest fit: 503 off, 404 without vegetation, 502 when the map is unreachable', async () => {
    const fit: ForestFitResult = {
        boundary,
        areaM2: 1e6,
        vegetatedShare: 0.7,
        classes: ['natural=wood'],
        source: 'OpenStreetMap',
    };
    const call = (data: OpenData | null) =>
        buildApp({ db: {} as Db, openData: data }).inject({
            method: 'POST',
            url: '/v1/forest-fit',
            payload: { boundary },
        });
    const [off, none, down, ok] = await Promise.all([
        call(null),
        call(openData()),
        call(
            openData({
                fitForest: vi.fn<OpenData['fitForest']>(async () => {
                    throw new OpenDataError('overpass timed out');
                }),
            }),
        ),
        call(openData({ fitForest: vi.fn<OpenData['fitForest']>(async () => fit) })),
    ]);
    expect([off.statusCode, none.statusCode, down.statusCode, ok.statusCode]).toEqual([
        503, 404, 502, 200,
    ]);
    expect(none.json()).toEqual({ error: 'no vegetation found inside that outline' });
    expect(ok.json()).toEqual(fit);
});

test('unassigned edge servers, the operator PATCH and drone names', async () => {
    const edgeRow = {
        id: 'edge-a',
        url: 'http://edge-a:8070',
        name: null,
        zoneId: null,
        lat: null,
        lng: null,
        connectivityRadiusM: null,
        createdAt: now,
        updatedAt: now,
    };
    const findMany = vi.fn<Stub>(async () => [edgeRow]);
    const update = vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => ({
        ...edgeRow,
        ...data,
    }));
    const upsert = vi.fn<(args: { create: Data }) => Promise<unknown>>(async ({ create }) => ({
        createdAt: now,
        updatedAt: now,
        ...create,
    }));
    const app = buildApp({
        db: { edgeServer: { findMany, update }, drone: { upsert } } as unknown as Db,
    });
    await app.inject({ method: 'GET', url: `/v1/edge-servers?unassigned=true&zoneId=${zoneId}` });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { zoneId: null } }));
    const patched = await app.inject({
        method: 'PATCH',
        url: '/v1/edge-servers/edge-a',
        payload: { name: 'N-1', location: { lat: 20.88, lng: -156.68 } },
    });
    expect(update.mock.calls[0]![0].data).toEqual({ name: 'N-1', lat: 20.88, lng: -156.68 });
    expect(patched.json()).toMatchObject({ name: 'N-1', live: null });
    const empty = await app.inject({
        method: 'PATCH',
        url: '/v1/edge-servers/edge-a',
        payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const drone = await app.inject({
        method: 'PUT',
        url: '/v1/drones/drone-1',
        payload: { edgeServerId: null, name: 'Kestrel', kind: 'simulated' },
    });
    expect(drone.json()).toMatchObject({ droneId: 'drone-1', name: 'Kestrel', kind: 'simulated' });
    const keep = await app.inject({
        method: 'PUT',
        url: '/v1/drones/drone-1',
        payload: { edgeServerId: null },
    });
    expect(keep.statusCode).toBe(200);
    expect(Object.keys((upsert.mock.calls[1]![0] as unknown as { update: object }).update)).toEqual(
        ['edgeServerId'],
    );
});
