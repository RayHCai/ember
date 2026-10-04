import { expect, test, vi } from 'vitest';
import type { PlannerJobRequest } from '@ember/contracts';
import { buildApp } from '../app.js';
import { newSession } from '../auth.js';
import type { Db } from '../db.js';
import type { OpenData } from '../openData/types.js';
import type { PlannerQueue } from '../queue.js';

type Stub = (...args: never[]) => unknown;

const zoneId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-0000000000aa';
const at = new Date('2026-10-03T00:00:00Z');
const jobRow = {
    id: jobId,
    zoneId,
    state: 'queued',
    requestedBy: 'op-1',
    requestedAt: at,
    options: null,
    message: null,
    result: null,
    updatedAt: at,
};

function queue(push: (job: PlannerJobRequest) => Promise<void>): PlannerQueue {
    return { push: vi.fn<PlannerQueue['push']>(push), close: async () => {} };
}

test('a planner job is stored, then queued as a PlannerJobRequest', async () => {
    const pushed: PlannerJobRequest[] = [];
    const db = { plannerJob: { create: vi.fn<Stub>(async () => jobRow) } } as unknown as Db;
    const res = await buildApp({ db, queue: queue(async (job) => void pushed.push(job)) }).inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/planner-jobs`,
        payload: { requestedBy: 'op-1', options: { horizonMin: 60 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ jobId, state: 'queued' });
    expect(pushed).toEqual([
        {
            jobId,
            zoneId,
            requestedAt: at.toISOString(),
            requestedBy: 'op-1',
            options: { horizonMin: 60 },
        },
    ]);
});

test('a job that cannot be queued is marked failed', async () => {
    const update = vi.fn<Stub>(async () => ({}));
    const db = { plannerJob: { create: vi.fn<Stub>(async () => jobRow), update } } as unknown as Db;
    const failing = queue(async () => {
        throw new Error('ECONNREFUSED');
    });
    const res = await buildApp({ db, queue: failing }).inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/planner-jobs`,
        payload: { requestedBy: 'op-1' },
    });
    expect(res.statusCode).toBe(503);
    expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
});

test('without a queue no job is created', async () => {
    const create = vi.fn<Stub>();
    const db = { plannerJob: { create } } as unknown as Db;
    const res = await buildApp({ db }).inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/planner-jobs`,
        payload: { requestedBy: 'op-1' },
    });
    expect(res.statusCode).toBe(503);
    expect(create).not.toHaveBeenCalled();
});

const status = (state: string) => ({
    jobId,
    zoneId,
    state,
    at: '2026-10-03T00:00:01Z',
    message: null,
});

test('status moves a job on, but never off succeeded', async () => {
    const findUnique = vi
        .fn<Stub>()
        .mockResolvedValueOnce({ zoneId, state: 'queued' })
        .mockResolvedValueOnce({ zoneId, state: 'succeeded' });
    const update = vi.fn<Stub>(async () => ({}));
    const app = buildApp({ db: { plannerJob: { findUnique, update } } as unknown as Db });
    const url = `/v1/planner/jobs/${jobId}/status`;
    const first = await app.inject({ method: 'POST', url, payload: status('gathering') });
    const late = await app.inject({ method: 'POST', url, payload: status('failed') });
    expect([first.statusCode, late.statusCode]).toEqual([204, 409]);
    expect(update).toHaveBeenCalledTimes(1);
});

test('a status for another zone is rejected', async () => {
    const findUnique = vi.fn<Stub>(async () => ({ zoneId, state: 'queued' }));
    const app = buildApp({ db: { plannerJob: { findUnique } } as unknown as Db });
    const res = await app.inject({
        method: 'POST',
        url: `/v1/planner/jobs/${jobId}/status`,
        payload: { ...status('planning'), zoneId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(res.statusCode).toBe(400);
});

test('a job defaults to the signed-in operator, and needs requestedBy otherwise', async () => {
    const session = newSession();
    const create = vi.fn<(args: { data: { requestedBy: string } }) => Promise<unknown>>(
        async ({ data }) => ({
            ...jobRow,
            requestedBy: data.requestedBy,
        }),
    );
    const db = {
        plannerJob: { create },
        operatorSession: {
            findUnique: vi.fn<Stub>(async () => ({
                expiresAt: session.expiresAt,
                operator: { id: 'op-7', email: 'ana@example.com', name: 'Ana', createdAt: at },
            })),
        },
    } as unknown as Db;
    const app = buildApp({ db, queue: queue(async () => {}) });
    const url = `/v1/watch-zones/${zoneId}/planner-jobs`;
    const mine = await app.inject({
        method: 'POST',
        url,
        payload: {},
        headers: { authorization: `Bearer ${session.token}` },
    });
    const anonymous = await app.inject({ method: 'POST', url });
    expect(mine.json()).toMatchObject({ requestedBy: 'op-7' });
    expect([mine.statusCode, anonymous.statusCode]).toEqual([202, 400]);
    expect(anonymous.json()).toEqual({
        error: 'requestedBy is required without an operator session',
    });
});

const boundary = [
    { lat: 20.87, lng: -156.69 },
    { lat: 20.89, lng: -156.69 },
    { lat: 20.89, lng: -156.67 },
];
const frameRow = {
    id: '00000000-0000-4000-8000-0000000000f1',
    droneId: 'drone-1',
    capturedAt: at,
    detections: [
        {
            detectionId: 'd1',
            risk: 'on_fire',
            confidence: 0.8,
            bboxPx: [0, 0, 10, 10],
            ground: [],
            centerLat: 20.88,
            centerLng: -156.68,
            areaM2: 50,
            peakTempK: 900,
        },
    ],
};
const surroundingsRow = (state: string) => ({
    zoneId,
    status: state,
    source: 'OpenStreetMap',
    fetchedAt: at,
    error: null,
    civilianAreas: [
        { id: 'a1', name: 'Lahaina', center: boundary[0], polygon: null, population: 1200 },
    ],
    roads: [{ id: 'r1', name: 'Front St', kind: 'primary', path: boundary }],
    safeZones: [{ id: 's1', name: 'Shelter', location: boundary[1], capacity: 300 }],
    stations: [{ id: 't1', name: 'Station 3', location: boundary[2] }],
    updatedAt: at,
});
const weather = {
    observedAt: at.toISOString(),
    windSpeedMps: 9,
    windFromDeg: 60,
    temperatureC: 31,
    relativeHumidityPct: 20,
};

function contextDb(surroundingsStatus: string | null) {
    return {
        watchZone: {
            findUnique: vi.fn<Stub>(async () => ({ id: zoneId, name: 'Lahaina', boundary })),
        },
        detectionFrame: { findMany: vi.fn<Stub>(async () => [frameRow]) },
        scan: { findFirst: vi.fn<Stub>(async () => ({ startedAt: new Date(0) })) },
        zoneSurroundings: {
            findUnique: vi.fn<Stub>(async () =>
                surroundingsStatus === null ? null : surroundingsRow(surroundingsStatus),
            ),
        },
    } as unknown as Db;
}

test('planner context carries the zone, its detections, risk zones, surroundings and weather', async () => {
    const openData: OpenData = {
        fitForest: vi.fn<OpenData['fitForest']>(),
        surroundings: vi.fn<OpenData['surroundings']>(),
        weather: vi.fn<OpenData['weather']>(async () => weather),
    };
    const res = await buildApp({ db: contextDb('ready'), openData }).inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}/planner-context`,
    });
    const context = res.json();
    expect(context).toMatchObject({
        zoneId,
        name: 'Lahaina',
        weather,
        detections: [
            {
                id: 'd1',
                risk: 'on_fire',
                center: { lat: 20.88, lng: -156.68 },
                peakTempK: 900,
                droneId: 'drone-1',
                capturedAt: at.toISOString(),
            },
        ],
        civilianAreas: [{ id: 'a1', population: 1200 }],
        roads: [{ id: 'r1', kind: 'primary' }],
        safeZones: [{ id: 's1' }],
        stations: [{ id: 't1' }],
    });
    expect(context.riskZones).toHaveLength(1);
    expect(Object.keys(context.riskZones[0]).toSorted()).toEqual([
        'confidence',
        'id',
        'observedAt',
        'polygon',
        'risk',
    ]);
    expect(context.riskZones[0]).toMatchObject({
        risk: 'on_fire',
        confidence: 0.8,
        observedAt: at.toISOString(),
    });
});

test('surroundings that are not ready and open data that is off leave the context empty', async () => {
    const res = await buildApp({ db: contextDb('pending') }).inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}/planner-context`,
    });
    expect(res.json()).toMatchObject({
        weather: null,
        civilianAreas: [],
        roads: [],
        safeZones: [],
        stations: [],
    });
});
