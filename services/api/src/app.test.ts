import { expect, test, vi } from 'vitest';
import { allowedOrigin, buildApp } from './app.js';
import { Prisma } from './generated/prisma/client.js';
import type { Db } from './db.js';

type Stub = (...args: never[]) => unknown;

function stubDb(create: (args: { data: { phone: string; zipCode: string } }) => unknown): Db {
    return { civilian: { create } } as unknown as Db;
}

const okDb = stubDb(async ({ data }) => ({
    id: '00000000-0000-0000-0000-000000000001',
    ...data,
    createdAt: new Date('2026-01-01T00:00:00Z'),
}));

test('health', async () => {
    const res = await buildApp({ db: okDb }).inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ service: 'api', ok: true });
});

test('creates a civilian', async () => {
    const res = await buildApp({ db: okDb }).inject({
        method: 'POST',
        url: '/civilians',
        payload: { phone: '+15551234567', zipCode: '96761' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ phone: '+15551234567', zipCode: '96761' });
});

test('rejects a malformed phone or zip', async () => {
    const app = buildApp({ db: okDb });
    const responses = await Promise.all(
        [
            { phone: '5551234567', zipCode: '96761' },
            { phone: '+15551234567', zipCode: '9676' },
        ].map((payload) => app.inject({ method: 'POST', url: '/civilians', payload })),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([400, 400]);
});

test('409 on duplicate phone', async () => {
    const db = stubDb(async () => {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
        });
    });
    const res = await buildApp({ db }).inject({
        method: 'POST',
        url: '/civilians',
        payload: { phone: '+15551234567', zipCode: '96761' },
    });
    expect(res.statusCode).toBe(409);
});

const zoneId = '00000000-0000-4000-8000-000000000001';
const zoneDb = {
    watchZone: {
        findUnique: vi.fn<Stub>(async () => ({
            id: zoneId,
            name: 'Lahaina',
            boundary: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        })),
    },
    detectionFrame: { findMany: vi.fn<Stub>(async () => []) },
    scan: { findFirst: vi.fn<Stub>(async () => null) },
    zoneSurroundings: { findUnique: vi.fn<Stub>(async () => null) },
} as unknown as Db;
const keys = { edge: 'edge-key', planner: 'planner-key' };
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

test('records need a service key once keys are set; signup stays open', async () => {
    const app = buildApp({ db: zoneDb, keys });
    const url = `/v1/watch-zones/${zoneId}`;
    const codes = await Promise.all([
        app.inject({ method: 'GET', url }),
        app.inject({ method: 'GET', url, headers: auth('nope') }),
        app.inject({ method: 'GET', url, headers: auth('edge-key') }),
        app.inject({ method: 'GET', url, headers: auth('planner-key') }),
    ]);
    expect(codes.map((r) => r.statusCode)).toEqual([401, 401, 200, 200]);
    const signup = await buildApp({ db: okDb, keys }).inject({
        method: 'POST',
        url: '/civilians',
        payload: { phone: '+15551234567', zipCode: '96761' },
    });
    expect(signup.statusCode).toBe(201);
});

test('planner routes take only the planner key', async () => {
    const app = buildApp({ db: zoneDb, keys });
    const url = `/v1/watch-zones/${zoneId}/planner-context`;
    const codes = await Promise.all([
        app.inject({ method: 'GET', url, headers: auth('edge-key') }),
        app.inject({ method: 'GET', url, headers: auth('planner-key') }),
    ]);
    expect(codes.map((r) => r.statusCode)).toEqual([401, 200]);
});

test('only the agent key lists civilians by zip', async () => {
    const findMany = vi.fn<Stub>(async () => [
        {
            id: '00000000-0000-0000-0000-000000000001',
            phone: '+15551234567',
            zipCode: '96761',
            createdAt: new Date('2026-01-01T00:00:00Z'),
        },
    ]);
    const db = { civilian: { findMany } } as unknown as Db;
    const app = buildApp({ db, keys: { ...keys, agent: 'agent-key' } });
    const url = '/v1/civilians?zipCode=96761';
    const codes = await Promise.all(
        [undefined, 'edge-key', 'planner-key', 'agent-key'].map((key) =>
            app.inject({ method: 'GET', url, headers: key ? auth(key) : {} }),
        ),
    );
    expect(codes.map((r) => r.statusCode)).toEqual([401, 403, 403, 200]);
    expect(codes[3]!.json()).toEqual([
        {
            id: '00000000-0000-0000-0000-000000000001',
            phone: '+15551234567',
            zipCode: '96761',
            createdAt: '2026-01-01T00:00:00.000Z',
        },
    ]);
    expect(findMany).toHaveBeenCalledWith({
        where: { zipCode: '96761' },
        orderBy: { createdAt: 'asc' },
    });
    const bad = await app.inject({
        method: 'GET',
        url: '/v1/civilians?zipCode=9676',
        headers: auth('agent-key'),
    });
    expect(bad.statusCode).toBe(400);
});

test('without keys every route is open', async () => {
    const res = await buildApp({ db: zoneDb }).inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}`,
    });
    expect(res.statusCode).toBe(200);
});

test('a zone boundary needs three points and ids are uuids', async () => {
    const app = buildApp({ db: zoneDb });
    const short = await app.inject({
        method: 'POST',
        url: '/v1/watch-zones',
        payload: {
            name: 'x',
            boundary: [
                { lat: 0, lng: 0 },
                { lat: 1, lng: 1 },
            ],
        },
    });
    const badId = await app.inject({ method: 'GET', url: '/v1/watch-zones/zone-1' });
    expect([short.statusCode, badId.statusCode]).toEqual([400, 400]);
});

const preflight = (origin: string) => ({
    method: 'OPTIONS' as const,
    url: '/v1/watch-zones',
    headers: {
        origin,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
    },
});

test('the dashboard origins pass a preflight without a bearer key', async () => {
    const app = buildApp({ db: zoneDb, keys, origins: ['https://ember.example.org'] });
    const origins = [
        'http://localhost:5173',
        'http://127.0.0.1:5174',
        'tauri://localhost',
        'http://tauri.localhost',
        'https://ember.example.org',
    ];
    const answers = await Promise.all(origins.map((origin) => app.inject(preflight(origin))));
    for (const [i, res] of answers.entries()) {
        expect(res.statusCode).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe(origins[i]);
        expect(res.headers['access-control-allow-methods']).toContain('PATCH');
        expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    }
    const evil = await app.inject(preflight('https://evil.example.com'));
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
});

test('answers carry the allowed origin', async () => {
    const res = await buildApp({ db: zoneDb }).inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}`,
        headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
});

test('allowedOrigin matches hosts exactly', () => {
    expect(allowedOrigin('http://localhost')).toBe(true);
    expect(allowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(allowedOrigin('http://evil.com/?http://localhost:5173')).toBe(false);
    expect(allowedOrigin('https://ops.example', ['https://ops.example'])).toBe(true);
});
