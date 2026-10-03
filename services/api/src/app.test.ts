import { expect, test } from 'vitest';
import { buildApp } from './app.js';
import { Prisma } from './generated/prisma/client.js';
import type { Db } from './db.js';

function stubDb(create: (args: { data: { phone: string; zipCode: string } }) => unknown): Db {
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

test('creates a civilian', async () => {
    const res = await buildApp(okDb).inject({
        method: 'POST',
        url: '/civilians',
        payload: { phone: '+15551234567', zipCode: '96761' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ phone: '+15551234567', zipCode: '96761' });
});

test('rejects a malformed phone or zip', async () => {
    const app = buildApp(okDb);
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
    const res = await buildApp(db).inject({
        method: 'POST',
        url: '/civilians',
        payload: { phone: '+15551234567', zipCode: '96761' },
    });
    expect(res.statusCode).toBe(409);
});
