import { expect, test, vi } from 'vitest';
import { buildApp } from './app.js';
import { hashPassword, newSession, sessionId, verifyPassword } from './auth.js';
import { Prisma } from './generated/prisma/client.js';
import type { Db } from './db.js';

type Stub = (...args: never[]) => unknown;
type SessionRow = { expiresAt: Date; operator: { id: string; email: string; name: string } };
type CreateOperator = {
    data: {
        email: string;
        name: string;
        passwordHash: string;
        sessions: { create: { id: string; expiresAt: Date } };
    };
};

const operatorId = '00000000-0000-4000-8000-0000000000a1';
const zoneId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-04T00:00:00Z');
const keys = { edge: 'edge-key', planner: 'planner-key' };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** An operators table of one and its sessions, in memory. */
async function authDb() {
    const operator = {
        id: operatorId,
        email: 'ana@example.com',
        name: 'Ana',
        passwordHash: await hashPassword('correct horse'),
        createdAt: now,
    };
    const sessions = new Map<string, SessionRow>();
    const signedIn = {
        id: operator.id,
        email: operator.email,
        name: operator.name,
        createdAt: now,
    };
    const db = {
        operator: {
            create: vi.fn<(args: CreateOperator) => Promise<unknown>>(async ({ data }) => {
                if (data.email === operator.email) {
                    throw new Prisma.PrismaClientKnownRequestError('dup', {
                        code: 'P2002',
                        clientVersion: 'test',
                    });
                }
                const created = { ...operator, email: data.email, name: data.name };
                sessions.set(data.sessions.create.id, {
                    expiresAt: data.sessions.create.expiresAt,
                    operator: created,
                });
                return created;
            }),
            findUnique: vi.fn<(args: { where: { email: string } }) => Promise<unknown>>(
                async ({ where }) => (where.email === operator.email ? operator : null),
            ),
        },
        operatorSession: {
            create: vi.fn<(args: { data: { id: string; expiresAt: Date } }) => Promise<unknown>>(
                async ({ data }) => {
                    sessions.set(data.id, { expiresAt: data.expiresAt, operator: signedIn });
                    return data;
                },
            ),
            findUnique: vi.fn<(args: { where: { id: string } }) => Promise<unknown>>(
                async ({ where }) => sessions.get(where.id) ?? null,
            ),
            deleteMany: vi.fn<(args: { where: { id: string } }) => Promise<unknown>>(
                async ({ where }) => ({
                    count: sessions.delete(where.id) ? 1 : 0,
                }),
            ),
        },
        watchZone: {
            findUnique: vi.fn<Stub>(async () => ({
                id: zoneId,
                name: 'Lahaina',
                region: null,
                boundary: [],
                scanEveryHours: null,
                nextScanAt: null,
                createdAt: now,
                updatedAt: now,
            })),
        },
    };
    return { db: db as unknown as Db, sessions, stubs: db };
}

test('passwords are scrypt hashes that verify only the same password', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    expect(await hashPassword('correct horse')).not.toBe(stored);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong horse', stored)).toBe(false);
    expect(await verifyPassword('correct horse', 'bcrypt$whatever')).toBe(false);
});

test('a session is a 32-byte token stored only as its hash', () => {
    const session = newSession(now);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.id).toBe(sessionId(session.token));
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(session.expiresAt.toISOString()).toBe('2026-10-11T00:00:00.000Z');
});

test('sign-up answers a session whose token opens /v1 routes', async () => {
    const { db, stubs } = await authDb();
    const app = buildApp({ db, keys });
    const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-up',
        payload: { email: 'Ben@Example.com', name: ' Ben ', password: 'long enough' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.operator).toMatchObject({ email: 'ben@example.com', name: 'Ben' });
    const created = stubs.operator.create.mock.calls[0]![0].data;
    expect(created.passwordHash).toMatch(/^scrypt\$/);
    expect(created.sessions.create.id).toBe(sessionId(body.token));

    const zone = await app.inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}`,
        headers: bearer(body.token),
    });
    const session = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: bearer(body.token),
    });
    expect(zone.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
        operator: { email: 'ben@example.com' },
        expiresAt: body.expiresAt,
    });
});

test('sign-up rejects a taken email, a short password and a bad email', async () => {
    const { db } = await authDb();
    const app = buildApp({ db });
    const codes = await Promise.all(
        [
            { email: 'ana@example.com', name: 'Ana', password: 'long enough' },
            { email: 'cy@example.com', name: 'Cy', password: 'short' },
            { email: 'not-an-email', name: 'Cy', password: 'long enough' },
            { email: 'cy@example.com', name: '   ', password: 'long enough' },
        ].map((payload) => app.inject({ method: 'POST', url: '/v1/auth/sign-up', payload })),
    );
    expect(codes.map((r) => r.statusCode)).toEqual([409, 400, 400, 400]);
});

test('sign-in gives the same answer for a wrong password and an unknown email', async () => {
    const { db } = await authDb();
    const app = buildApp({ db, keys });
    const signIn = (email: string, password: string) =>
        app.inject({ method: 'POST', url: '/v1/auth/sign-in', payload: { email, password } });
    const [good, wrong, unknown] = await Promise.all([
        signIn('ANA@example.com', 'correct horse'),
        signIn('ana@example.com', 'wrong horse!'),
        signIn('nobody@example.com', 'correct horse'),
    ]);
    expect(good.statusCode).toBe(200);
    expect(good.json().operator).toMatchObject({ operatorId, email: 'ana@example.com' });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toEqual({ error: 'wrong email or password' });
});

test('signing out ends the session; expired and unknown sessions are refused', async () => {
    const { db, sessions } = await authDb();
    const app = buildApp({ db, keys });
    const signedIn = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email: 'ana@example.com', password: 'correct horse' },
    });
    const { token } = signedIn.json();
    const out = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/session',
        headers: bearer(token),
    });
    const after = await app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: bearer(token),
    });
    expect([out.statusCode, after.statusCode]).toEqual([204, 401]);

    const expired = newSession(new Date('2026-01-01T00:00:00Z'));
    sessions.set(expired.id, {
        expiresAt: expired.expiresAt,
        operator: { id: operatorId, email: 'ana@example.com', name: 'Ana' },
    });
    const old = await app.inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}`,
        headers: bearer(expired.token),
    });
    const stranger = await app.inject({
        method: 'GET',
        url: `/v1/watch-zones/${zoneId}`,
        headers: bearer(newSession().token),
    });
    expect([old.statusCode, stranger.statusCode]).toEqual([401, 401]);
});

test('a service key is not an operator session', async () => {
    const { db } = await authDb();
    const res = await buildApp({ db, keys }).inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: bearer('edge-key'),
    });
    expect(res.statusCode).toBe(401);
});

test('without keys every route is open, and a session still names its operator', async () => {
    const { db } = await authDb();
    const app = buildApp({ db });
    const { token } = (
        await app.inject({
            method: 'POST',
            url: '/v1/auth/sign-in',
            payload: { email: 'ana@example.com', password: 'correct horse' },
        })
    ).json();
    const [open, mine] = await Promise.all([
        app.inject({ method: 'GET', url: `/v1/watch-zones/${zoneId}` }),
        app.inject({ method: 'GET', url: '/v1/auth/session', headers: bearer(token) }),
    ]);
    expect(open.statusCode).toBe(200);
    expect(mine.json().operator).toMatchObject({ operatorId });
});
