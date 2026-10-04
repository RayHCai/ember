import { expect, test, vi } from 'vitest';
import type { DroneDetections, EdgeRun } from '@ember/contracts';
import { buildApp } from '../app.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../db.js';
import { mergeCells } from './mappingRuns.js';

type Stub = (...args: never[]) => unknown;
type Upsert = (args: { create: Record<string, unknown> }) => Promise<unknown>;
type FrameData = Record<string, unknown> & { detections: { create: unknown[] } };

const zoneId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-03T00:00:00Z');
const dbError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });

const frame = (frameId: number): DroneDetections => ({
    type: 'detections',
    droneId: 'drone-1',
    frameId,
    capturedAt: '2026-10-03T00:00:01Z',
    scenarioTime: '2023-08-08T15:00:00-10:00',
    pose: { lat: 20.88, lng: -156.68, altM: 80, headingDeg: 0, pitchDeg: -90 },
    camera: { widthPx: 640, heightPx: 480, hfovDeg: 90 },
    detector: 'yolo',
    detections: [
        {
            id: 'd1',
            risk: 'on_fire',
            confidence: 0.9,
            bboxPx: [1, 2, 3, 4],
            ground: [
                { lat: 20.88, lng: -156.68 },
                { lat: 20.881, lng: -156.68 },
                { lat: 20.881, lng: -156.681 },
            ],
            center: { lat: 20.8805, lng: -156.6805 },
            areaM2: 120,
        },
    ],
});

test('mergeCells is a sorted union', () => {
    expect(mergeCells([5, 1, 3], [3, 2, 2, 9])).toEqual([1, 2, 3, 5, 9]);
});

test('a mapping run update adds new cells to the stored ones', async () => {
    const upsert = vi.fn<Upsert>(async (args) => ({
        ...args.create,
        createdAt: now,
        updatedAt: now,
    }));
    const db = {
        mappingRun: { findUnique: vi.fn<Stub>(async () => ({ cells: [1, 4] })), upsert },
        scan: { findUnique: vi.fn<Stub>(async () => null) },
    } as unknown as Db;
    const run: EdgeRun = {
        runId: 'run-1',
        zoneId,
        state: 'mapping',
        startedAt: '2026-10-03T00:00:00Z',
        swarm: ['drone-1'],
        edgeServer: { lat: 20.88, lng: -156.68 },
        connectivityRadiusM: 300,
        cellSizeM: 10,
        coverage: 0.2,
        newCells: [4, 2],
    };
    const res = await buildApp({ db }).inject({
        method: 'PUT',
        url: '/v1/mapping-runs/run-1/edge-servers/edge-a',
        payload: run,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId: 'run-1', edgeServerId: 'edge-a', cells: [1, 2, 4] });
});

test('a mapping run body must name the run in the path', async () => {
    const db = { mappingRun: {} } as unknown as Db;
    const res = await buildApp({ db }).inject({
        method: 'PUT',
        url: '/v1/mapping-runs/run-2/edge-servers/edge-a',
        payload: {
            runId: 'run-1',
            zoneId,
            state: 'mapping',
            startedAt: '2026-10-03T00:00:00Z',
            edgeServer: { lat: 0, lng: 0 },
            connectivityRadiusM: 300,
            cellSizeM: 10,
            coverage: 0,
            newCells: [],
        },
    });
    expect(res.statusCode).toBe(400);
});

test('detections land in the zone of the drone and duplicates are counted', async () => {
    const create = vi
        .fn<(args: { data: FrameData }) => Promise<unknown>>()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(dbError('P2002'));
    const db = {
        drone: {
            findMany: vi.fn<Stub>(async () => [
                { id: 'drone-1', edgeServerId: 'edge-a', edgeServer: { zoneId } },
            ]),
        },
        detectionFrame: { create },
    } as unknown as Db;
    const res = await buildApp({ db }).inject({
        method: 'POST',
        url: '/v1/detections',
        payload: { frames: [frame(1), frame(1)] },
    });
    expect(res.json()).toEqual({ accepted: 1, duplicates: 1 });
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ zoneId, edgeServerId: 'edge-a', droneId: 'drone-1', frameId: 1 });
    expect(data.detections.create[0]).toMatchObject({
        detectionId: 'd1',
        risk: 'on_fire',
        bboxPx: [1, 2, 3, 4],
        centerLat: 20.8805,
        peakTempK: null,
    });
});

test('a detection with an unknown risk class or a short box is rejected', async () => {
    const app = buildApp({ db: {} as Db });
    const bad = [
        { ...frame(1), detections: [{ ...frame(1).detections[0]!, risk: 'smoke' }] },
        { ...frame(1), detections: [{ ...frame(1).detections[0]!, bboxPx: [1, 2, 3] }] },
    ];
    const codes = await Promise.all(
        bad.map((f) =>
            app.inject({ method: 'POST', url: '/v1/detections', payload: { frames: [f] } }),
        ),
    );
    expect(codes.map((r) => r.statusCode)).toEqual([400, 400]);
});

test("a connector's registration keeps the zone an operator set", async () => {
    const upsert = vi.fn<Upsert>(async (args) => ({
        zoneId: null,
        lat: null,
        lng: null,
        connectivityRadiusM: null,
        ...args.create,
        createdAt: now,
        updatedAt: now,
    }));
    const db = { edgeServer: { upsert } } as unknown as Db;
    await buildApp({ db }).inject({
        method: 'PUT',
        url: '/v1/edge-servers/edge-a',
        payload: { url: 'http://192.168.1.20:8070' },
    });
    expect(upsert.mock.calls[0]![0]).toMatchObject({
        update: { url: 'http://192.168.1.20:8070' },
        create: { id: 'edge-a', url: 'http://192.168.1.20:8070' },
    });
    expect(Object.keys((upsert.mock.calls[0]![0] as { update: object }).update)).toEqual(['url']);
});

test('assigning a drone to an unregistered edge server is a conflict', async () => {
    const db = {
        drone: {
            upsert: vi.fn<Stub>(async () => {
                throw dbError('P2003');
            }),
        },
    } as unknown as Db;
    const res = await buildApp({ db }).inject({
        method: 'PUT',
        url: '/v1/drones/drone-1',
        payload: { edgeServerId: 'edge-x' },
    });
    expect(res.statusCode).toBe(409);
});

test('deleting a missing row is 404', async () => {
    const db = {
        drone: {
            delete: vi.fn<Stub>(async () => {
                throw dbError('P2025');
            }),
        },
    } as unknown as Db;
    const res = await buildApp({ db }).inject({ method: 'DELETE', url: '/v1/drones/drone-1' });
    expect(res.statusCode).toBe(404);
});
