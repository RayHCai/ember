import { expect, test, vi } from 'vitest';
import type { EdgeServerStatus } from '@ember/contracts';
import { buildApp } from '../app.js';
import type { Db } from '../db.js';
import type { EdgeManager } from '../edgeManager.js';
import { projection } from '../geo.js';

type Stub = (...args: never[]) => unknown;
type Data = Record<string, unknown>;

const zoneId = '00000000-0000-4000-8000-000000000001';
const placementId = '00000000-0000-4000-8000-0000000000b1';
const now = new Date('2026-10-04T12:00:00Z');
const center = { lat: 20.88, lng: -156.68 };
const proj = projection(center);
const at = (x: number, y: number) => proj.toLatLng({ x, y });
const boundary = [at(-1000, -1000), at(1000, -1000), at(1000, 1000), at(-1000, 1000)];
const zone = { id: zoneId, boundary };
const placement = {
    id: placementId,
    zoneId,
    name: 'NE-1',
    lat: 20.885,
    lng: -156.675,
    connectivityRadiusM: 400,
    createdAt: now,
    updatedAt: now,
};
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

/** `$transaction` runs its callback against the same stubs. */
function withTransaction<T extends object>(stubs: T): Db {
    const db = { ...stubs, $transaction: async (fn: (tx: T) => unknown) => fn(stubs) };
    return db as unknown as Db;
}

test('assigning a placement gives its edge server the zone, name, position and radius', async () => {
    const update = vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => ({
        ...edgeRow,
        ...data,
    }));
    const remove = vi.fn<Stub>(async () => placement);
    const db = withTransaction({
        edgeServerPlacement: { findUnique: vi.fn<Stub>(async () => placement), delete: remove },
        edgeServer: { findUnique: vi.fn<Stub>(async () => ({ id: 'edge-a' })), update },
    });
    const live: EdgeServerStatus = {
        edgeServerId: 'edge-a',
        url: edgeRow.url,
        online: true,
        connectedAt: now.toISOString(),
        lastSeen: now.toISOString(),
        drones: 2,
        connectedDrones: 2,
        run: null,
    };
    const edgeManager: EdgeManager = {
        live: async () => new Map([['edge-a', live]]),
        task: vi.fn<EdgeManager['task']>(),
    };
    const res = await buildApp({ db, edgeManager }).inject({
        method: 'POST',
        url: `/v1/placements/${placementId}/assign`,
        payload: { edgeServerId: 'edge-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({
        where: { id: 'edge-a' },
        data: {
            zoneId,
            name: 'NE-1',
            lat: 20.885,
            lng: -156.675,
            connectivityRadiusM: 400,
        },
    });
    expect(remove).toHaveBeenCalledWith({ where: { id: placementId } });
    expect(res.json()).toMatchObject({
        edgeServerId: 'edge-a',
        name: 'NE-1',
        zoneId,
        location: { lat: 20.885, lng: -156.675 },
        connectivityRadiusM: 400,
        live: { online: true, drones: 2 },
    });
});

test('assigning to an unregistered edge server or a missing placement is 404', async () => {
    const update = vi.fn<Stub>();
    const remove = vi.fn<Stub>();
    const app = (placementRow: object | null, edge: object | null) =>
        buildApp({
            db: withTransaction({
                edgeServerPlacement: {
                    findUnique: vi.fn<Stub>(async () => placementRow),
                    delete: remove,
                },
                edgeServer: { findUnique: vi.fn<Stub>(async () => edge), update },
            }),
        });
    const assign = { method: 'POST' as const, url: `/v1/placements/${placementId}/assign` };
    const noEdge = await app(placement, null).inject({
        ...assign,
        payload: { edgeServerId: 'edge-x' },
    });
    const noPlacement = await app(null, { id: 'edge-a' }).inject({
        ...assign,
        payload: { edgeServerId: 'edge-a' },
    });
    expect([noEdge.statusCode, noPlacement.statusCode]).toEqual([404, 404]);
    expect(noEdge.json()).toEqual({ error: 'edge server edge-x not found' });
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
});

test('suggest replaces the zone placements with named sites that reach the target', async () => {
    const deleteMany = vi.fn<Stub>(async () => ({ count: 3 }));
    const createManyAndReturn = vi.fn<(args: { data: Data[] }) => Promise<unknown>>(
        async ({ data }) =>
            data.map((d, i) => ({ ...d, id: `p-${i}`, createdAt: now, updatedAt: now })),
    );
    const db = withTransaction({
        watchZone: { findUnique: vi.fn<Stub>(async () => zone) },
        edgeServer: {
            findMany: vi.fn<(args: { select: Data }) => Promise<unknown>>(async ({ select }) =>
                'name' in select ? [{ name: 'N-1' }] : [],
            ),
        },
        edgeServerPlacement: { deleteMany, createManyAndReturn },
    });
    const res = await buildApp({ db }).inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/placements/suggest`,
        payload: { targetCoverage: 0.9, connectivityRadiusM: 500 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(deleteMany).toHaveBeenCalledWith({ where: { zoneId } });
    expect(body.coverage).toBe(0);
    expect(body.projectedCoverage).toBeGreaterThanOrEqual(0.9);
    const names: string[] = body.placements.map((p: { name: string }) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('N-1');
    for (const name of names) expect(name).toMatch(/^(N|NE|E|SE|S|SW|W|NW)-\d+$/);
    expect(body.placements[0]).toMatchObject({ zoneId, connectivityRadiusM: 500 });
});

test('a pinpointed placement is named after its direction and the free number', async () => {
    const create = vi.fn<(args: { data: Data }) => Promise<unknown>>(async ({ data }) => ({
        ...data,
        id: placementId,
        createdAt: now,
        updatedAt: now,
    }));
    const db = {
        watchZone: { findUnique: vi.fn<Stub>(async () => zone) },
        edgeServer: { findMany: vi.fn<Stub>(async () => [{ name: 'NE-1' }]) },
        edgeServerPlacement: {
            findMany: vi.fn<Stub>(async () => [{ name: 'NE-2' }]),
            create,
        },
    } as unknown as Db;
    const res = await buildApp({ db }).inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/placements`,
        payload: { location: at(400, 400) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'NE-3', connectivityRadiusM: 500, zoneId });
});
