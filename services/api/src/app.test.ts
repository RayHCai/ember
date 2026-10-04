import { expect, test } from 'vitest';
import { buildApp } from './app.js';
import { Prisma } from './generated/prisma/client.js';
import type { Db } from './db.js';

function stubDb(create: (args: { data: { email: string; zipCode: string } }) => unknown): Db {
    return { civilian: { create } } as unknown as Db;
}

const okDb = stubDb(async ({ data }) => ({
    id: '00000000-0000-0000-0000-000000000001',
    ...data,
    createdAt: new Date('2026-01-01T00:00:00Z'),
}));

test('health', async () => {
    const res = await buildApp(okDb).inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ service: 'api', ok: true });
});

test('creates a civilian with a lowercased email', async () => {
    const res = await buildApp(okDb).inject({
        method: 'POST',
        url: '/civilians',
        payload: { email: 'Kai@Example.com', zipCode: '96761' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'kai@example.com', zipCode: '96761' });
});

test('rejects a malformed email or zip', async () => {
    const app = buildApp(okDb);
    const responses = await Promise.all(
        [
            { email: 'kai@example', zipCode: '96761' },
            { email: 'kai@example.com', zipCode: '9676' },
        ].map((payload) => app.inject({ method: 'POST', url: '/civilians', payload })),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([400, 400]);
});

test('409 on duplicate email', async () => {
    const db = stubDb(async () => {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
        });
    });
    const res = await buildApp(db).inject({
        method: 'POST',
        url: '/civilians',
        payload: { email: 'kai@example.com', zipCode: '96761' },
    });
    expect(res.statusCode).toBe(409);
});
