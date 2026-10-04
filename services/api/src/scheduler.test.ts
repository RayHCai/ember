import { expect, test, vi } from 'vitest';
import type { EdgeTask, EdgeTaskResult } from '@ember/contracts';
import type { Db } from './db.js';
import type { EdgeManager } from './edgeManager.js';
import { IDLE_ERROR, startDueScans, sweepIdleScans } from './scheduler.js';

type Stub = (...args: never[]) => unknown;

const zoneId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-04T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
type LogFn = (...args: unknown[]) => void;
const log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
const dueZone = {
    id: zoneId,
    boundary: [
        { lat: 20.87, lng: -156.69 },
        { lat: 20.87, lng: -156.67 },
        { lat: 20.89, lng: -156.68 },
    ],
    scanEveryHours: 6,
    nextScanAt: minutesAgo(1),
};
const edgeServer = {
    id: 'edge-a',
    url: 'http://10.0.0.2:8070',
    lat: 20.88,
    lng: -156.68,
    connectivityRadiusM: 500,
};

function edgeManager(answer: (task: EdgeTask) => EdgeTaskResult): EdgeManager {
    return {
        live: async () => null,
        task: vi.fn<EdgeManager['task']>(async (task) => answer(task)),
    };
}

function scheduleDb({ claimed = 1, active = null as object | null } = {}) {
    const stubs = {
        watchZone: {
            findMany: vi.fn<Stub>(async () => [dueZone]),
            updateMany: vi.fn<Stub>(async () => ({ count: claimed })),
        },
        scan: {
            findFirst: vi.fn<Stub>(async () => active),
            create: vi.fn<Stub>(async () => ({})),
            update: vi.fn<(args: { data: object }) => Promise<unknown>>(async ({ data }) => ({
                runId: 'run-x',
                state: 'mapping',
                ...data,
            })),
        },
        edgeServer: { findMany: vi.fn<Stub>(async () => [edgeServer]) },
    };
    return { db: stubs as unknown as Db, stubs };
}

test('a due zone is moved on first, then scanned by the schedule', async () => {
    const { db, stubs } = scheduleDb();
    const manager = edgeManager((task) => ({
        runId: task.runId,
        results: [{ edgeServerId: 'edge-a', ok: true, drones: ['drone-1'] }],
    }));
    const started = await startDueScans({ db, edgeManager: manager }, log, now);
    expect(started).toHaveLength(1);
    expect(stubs.watchZone.updateMany).toHaveBeenCalledWith({
        where: { id: zoneId, nextScanAt: dueZone.nextScanAt },
        data: { nextScanAt: new Date('2026-10-04T18:00:00Z') },
    });
    expect(stubs.scan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ zoneId, requestedBy: 'schedule', state: 'starting' }),
    });
    expect(manager.task).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'start_mapping', zoneId, cellSizeM: 10 }),
    );
});

test('a zone another instance claimed, or one already scanning, is not started', async () => {
    const claimedElsewhere = scheduleDb({ claimed: 0 });
    const manager = edgeManager(() => ({ runId: 'x', results: [] }));
    await startDueScans({ db: claimedElsewhere.db, edgeManager: manager }, log, now);
    expect(claimedElsewhere.stubs.scan.findFirst).not.toHaveBeenCalled();

    const busy = scheduleDb({ active: { runId: 'run-1', state: 'mapping' } });
    const started = await startDueScans({ db: busy.db, edgeManager: manager }, log, now);
    expect(started).toEqual([]);
    expect(busy.stubs.watchZone.updateMany).toHaveBeenCalled();
    expect(busy.stubs.scan.create).not.toHaveBeenCalled();
    expect(manager.task).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('run-1 is mapping'));
});

test('a scan with no word from the edge for 10 minutes is ended', async () => {
    const updateMany = vi.fn<Stub>(async () => ({ count: 1 }));
    const db = {
        scan: {
            findMany: vi.fn<Stub>(async () => [
                { runId: 'run-idle', updatedAt: minutesAgo(30) },
                { runId: 'run-busy', updatedAt: minutesAgo(30) },
                { runId: 'run-new', updatedAt: minutesAgo(2) },
            ]),
            updateMany,
        },
        mappingRun: {
            findMany: vi.fn<Stub>(async () => [
                { runId: 'run-idle', updatedAt: minutesAgo(11) },
                { runId: 'run-busy', updatedAt: minutesAgo(11) },
                { runId: 'run-busy', updatedAt: minutesAgo(1) },
            ]),
        },
    } as unknown as Db;
    expect(await sweepIdleScans({ db }, now)).toEqual(['run-idle']);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
        where: { runId: 'run-idle', state: { in: ['starting', 'mapping', 'stopping'] } },
        data: { state: 'done', endedAt: now, error: IDLE_ERROR },
    });
});
