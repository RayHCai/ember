import { expect, test, vi } from 'vitest';
import type { EdgeRun, EdgeServerTaskResult, EdgeTask, EdgeTaskResult } from '@ember/contracts';
import { buildApp } from '../app.js';
import type { Db } from '../db.js';
import { EdgeManagerError, type EdgeManager } from '../edgeManager.js';

type Stub = (...args: never[]) => unknown;
type ScanRow = Record<string, unknown> & { runId: string; state: string };

const zoneId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-04T12:00:00Z');
const boundary = [
    { lat: 20.87, lng: -156.69 },
    { lat: 20.87, lng: -156.67 },
    { lat: 20.89, lng: -156.68 },
];
const edge = (id: string, located = true) => ({
    id,
    url: `http://${id}:8070`,
    zoneId,
    lat: located ? 20.88 : null,
    lng: located ? -156.68 : null,
    connectivityRadiusM: located ? 500 : null,
});

/** One zone, its edge servers, and a scans table in memory. */
function scanDb({
    scans = [] as ScanRow[],
    edges = [edge('edge-a'), edge('edge-b')],
    runs = [] as { runId: string; edgeServerId: string; state: string; coverage: number }[],
} = {}) {
    const table = new Map(scans.map((s) => [s.runId, s]));
    const stubs = {
        watchZone: { findUnique: vi.fn<Stub>(async () => ({ id: zoneId, boundary })) },
        edgeServer: {
            findMany: vi.fn<(args: { where: { id?: { in: string[] } } }) => Promise<unknown>>(
                async ({ where }) =>
                    where.id ? edges.filter((e) => where.id!.in.includes(e.id)) : edges,
            ),
        },
        scan: {
            findMany: vi.fn<() => Promise<unknown>>(async () => [...table.values()]),
            findFirst: vi.fn<() => Promise<unknown>>(
                async () =>
                    [...table.values()].find((s) =>
                        ['starting', 'mapping', 'stopping'].includes(s.state),
                    ) ?? null,
            ),
            findUnique: vi.fn<(args: { where: { runId: string } }) => Promise<unknown>>(
                async ({ where }) => table.get(where.runId) ?? null,
            ),
            create: vi.fn<(args: { data: ScanRow }) => Promise<unknown>>(async ({ data }) => {
                const row = { endedAt: null, error: null, updatedAt: now, ...data };
                table.set(data.runId, row);
                return row;
            }),
            update: vi.fn<
                (args: { where: { runId: string }; data: Partial<ScanRow> }) => Promise<unknown>
            >(async ({ where, data }) => {
                const row = { ...table.get(where.runId)!, ...data };
                table.set(where.runId, row);
                return row;
            }),
        },
        mappingRun: {
            findMany: vi.fn<Stub>(async () => runs),
            findUnique: vi.fn<Stub>(async () => null),
            upsert: vi.fn<(args: { create: Record<string, unknown> }) => Promise<unknown>>(
                async ({ create }) => ({
                    ...create,
                    createdAt: now,
                    updatedAt: now,
                }),
            ),
        },
    };
    return { db: stubs as unknown as Db, stubs, table };
}

function manager(answer: (task: EdgeTask) => EdgeTaskResult | Error): EdgeManager {
    return {
        live: async () => null,
        task: vi.fn<EdgeManager['task']>(async (task) => {
            const result = answer(task);
            if (result instanceof Error) throw result;
            return result;
        }),
    };
}

const startUrl = `/v1/watch-zones/${zoneId}/scans`;
const results =
    (...rs: EdgeServerTaskResult[]) =>
    (task: EdgeTask) => ({
        runId: task.runId,
        results: rs,
    });

test('a scan sends one start task for the positioned edge servers and maps', async () => {
    const { db } = scanDb({ edges: [edge('edge-a'), edge('edge-b')] });
    const edgeManager = manager(
        results(
            { edgeServerId: 'edge-a', ok: true, drones: ['drone-1'] },
            { edgeServerId: 'edge-b', ok: false, error: 'no drones connected' },
        ),
    );
    const res = await buildApp({ db, edgeManager }).inject({
        method: 'POST',
        url: startUrl,
        payload: {},
    });
    expect(res.statusCode).toBe(201);
    const scan = res.json();
    expect(scan).toMatchObject({
        zoneId,
        requestedBy: 'service',
        state: 'mapping',
        cellSizeM: 10,
        coverage: 0,
        error: 'edge-b: no drones connected',
    });
    expect(scan.runId).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(edgeManager.task).toHaveBeenCalledWith({
        kind: 'start_mapping',
        runId: scan.runId,
        zoneId,
        boundary,
        cellSizeM: 10,
        altitude: { minM: 60, maxM: 120 },
        edgeServers: [
            {
                edgeServerId: 'edge-a',
                url: 'http://edge-a:8070',
                location: { lat: 20.88, lng: -156.68 },
                connectivityRadiusM: 500,
            },
            {
                edgeServerId: 'edge-b',
                url: 'http://edge-b:8070',
                location: { lat: 20.88, lng: -156.68 },
                connectivityRadiusM: 500,
            },
        ],
    });
});

test('a scan every edge server refuses is failed with their reasons', async () => {
    const { db, table } = scanDb();
    const edgeManager = manager(
        results(
            { edgeServerId: 'edge-a', ok: false, error: 'busy' },
            { edgeServerId: 'edge-b', ok: false, error: 'offline' },
        ),
    );
    const res = await buildApp({ db, edgeManager }).inject({
        method: 'POST',
        url: startUrl,
        payload: { cellSizeM: 20 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
        state: 'failed',
        cellSizeM: 20,
        error: 'edge-a: busy; edge-b: offline',
    });
    expect([...table.values()][0]!.endedAt).toBeInstanceOf(Date);
});

test('an unreachable edge-manager fails the scan and answers 502', async () => {
    const { db, table } = scanDb();
    const edgeManager = manager(() => new EdgeManagerError('edge-manager at x: ECONNREFUSED'));
    const res = await buildApp({ db, edgeManager }).inject({
        method: 'POST',
        url: startUrl,
        payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect([...table.values()][0]).toMatchObject({ state: 'failed' });
});

test('no scan without edge-manager, while one runs, or without a positioned edge server', async () => {
    const edgeManager = manager(results({ edgeServerId: 'edge-a', ok: true, drones: [] }));
    const off = await buildApp({ db: scanDb().db }).inject({ method: 'POST', url: startUrl });
    const running = await buildApp({
        db: scanDb({ scans: [{ runId: 'run-1', zoneId, state: 'mapping' }] }).db,
        edgeManager,
    }).inject({ method: 'POST', url: startUrl, payload: {} });
    const unplaced = await buildApp({ db: scanDb({ edges: [] }).db, edgeManager }).inject({
        method: 'POST',
        url: startUrl,
        payload: {},
    });
    expect([off.statusCode, running.statusCode, unplaced.statusCode]).toEqual([503, 409, 409]);
    expect(edgeManager.task).not.toHaveBeenCalled();
});

test('stop goes to the edge servers that took the scan', async () => {
    const { db, table } = scanDb({
        scans: [
            {
                runId: 'run-1',
                zoneId,
                state: 'mapping',
                requestedBy: 'service',
                startedAt: now,
                endedAt: null,
                cellSizeM: 10,
                error: null,
                updatedAt: now,
                results: [
                    { edgeServerId: 'edge-a', ok: true, drones: ['drone-1'] },
                    { edgeServerId: 'edge-b', ok: false, error: 'busy' },
                ],
            },
        ],
    });
    const edgeManager = manager((task) => ({ runId: task.runId, results: [] }));
    const res = await buildApp({ db, edgeManager }).inject({
        method: 'POST',
        url: `${startUrl}/run-1/stop`,
    });
    expect(res.statusCode).toBe(200);
    expect(edgeManager.task).toHaveBeenCalledWith({
        kind: 'stop_mapping',
        runId: 'run-1',
        zoneId,
        edgeServers: [{ edgeServerId: 'edge-a', url: 'http://edge-a:8070' }],
    });
    expect(table.get('run-1')!.state).toBe('stopping');
});

const edgeRun = (edgeServerId: string, state: EdgeRun['state']): EdgeRun => ({
    runId: 'run-1',
    zoneId,
    state,
    startedAt: now.toISOString(),
    swarm: [`${edgeServerId}-drone`],
    edgeServer: { lat: 20.88, lng: -156.68 },
    connectivityRadiusM: 500,
    cellSizeM: 10,
    coverage: 0.5,
    newCells: [1],
});

const scanRow = (state: string, taskResults: EdgeServerTaskResult[] = []): ScanRow => ({
    runId: 'run-1',
    zoneId,
    state,
    results: taskResults,
});
const took = [
    { edgeServerId: 'edge-a', ok: true as const, drones: [] },
    { edgeServerId: 'edge-b', ok: true as const, drones: [] },
];
const put = (db: Db, edgeServerId: string, state: EdgeRun['state']) =>
    buildApp({ db }).inject({
        method: 'PUT',
        url: `/v1/mapping-runs/run-1/edge-servers/${edgeServerId}`,
        payload: edgeRun(edgeServerId, state),
    });

test('mapping-run reports move the scan: starting to mapping, then done when all are', async () => {
    const starting = scanDb({ scans: [scanRow('starting')] });
    await put(starting.db, 'edge-a', 'mapping');
    expect(starting.table.get('run-1')!.state).toBe('mapping');

    const half = scanDb({
        scans: [scanRow('mapping', took)],
        runs: [{ runId: 'run-1', edgeServerId: 'edge-a', state: 'done', coverage: 1 }],
    });
    await put(half.db, 'edge-a', 'done');
    expect(half.stubs.scan.update).not.toHaveBeenCalled();

    const all = scanDb({
        scans: [scanRow('stopping', took)],
        runs: [
            { runId: 'run-1', edgeServerId: 'edge-a', state: 'done', coverage: 1 },
            { runId: 'run-1', edgeServerId: 'edge-b', state: 'done', coverage: 0.8 },
        ],
    });
    await put(all.db, 'edge-b', 'done');
    expect(all.table.get('run-1')).toMatchObject({ state: 'done', endedAt: expect.any(Date) });
});

test('a scan lists with the mean coverage of its mapping runs', async () => {
    const { db } = scanDb({
        scans: [
            {
                ...scanRow('mapping', took),
                requestedBy: 'service',
                startedAt: now,
                endedAt: null,
                cellSizeM: 10,
                error: null,
                updatedAt: now,
            },
        ],
        runs: [
            { runId: 'run-1', edgeServerId: 'edge-a', state: 'mapping', coverage: 0.5 },
            { runId: 'run-1', edgeServerId: 'edge-b', state: 'mapping', coverage: 0.25 },
        ],
    });
    const res = await buildApp({ db }).inject({ method: 'GET', url: startUrl });
    expect(res.json()).toMatchObject([{ runId: 'run-1', coverage: 0.375 }]);
});
