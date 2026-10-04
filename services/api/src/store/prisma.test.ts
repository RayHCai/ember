import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PlannerJob } from '@ember/contracts';
import { createPrisma } from '../db.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DuplicateError, TABLES } from './index.js';
import { prismaStore } from './prisma.js';

// Needs a migrated database: `EMBER_TEST_DATABASE_URL=... pnpm --filter @ember/api test`.
const url = process.env.EMBER_TEST_DATABASE_URL;

const job = (
    jobId: string,
    zoneId: string,
    state: PlannerJob['state'],
    at: string,
): PlannerJob => ({
    jobId,
    zoneId: zoneId as PlannerJob['zoneId'],
    state,
    requestedBy: 'ember',
    requestedAt: at,
    updatedAt: at,
    message: null,
    options: { horizonMin: 120 },
    reason: null,
    incidentId: null,
});

describe.skipIf(!url)('prisma store', () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
        prisma = createPrisma(url);
        const tables = [...Object.values(TABLES).map((t) => t.table), 'counters', 'civilians'];
        await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(', ')}`);
    });

    afterAll(async () => prisma.$disconnect());

    test('collections insert once, replace, filter on zone and fields, order and limit', async () => {
        const store = prismaStore(prisma);
        expect(
            await store.plannerJobs.insert(job('j1', 'z1', 'queued', '2026-10-03T12:00:00Z')),
        ).toBe(true);
        expect(
            await store.plannerJobs.insert(job('j1', 'z1', 'failed', '2026-10-03T12:00:00Z')),
        ).toBe(false);
        await store.plannerJobs.put(job('j1', 'z1', 'succeeded', '2026-10-03T12:00:00Z'));
        await store.plannerJobs.put(job('j2', 'z1', 'succeeded', '2026-10-03T12:05:00Z'));
        await store.plannerJobs.put(job('j3', 'z2', 'succeeded', '2026-10-03T12:09:00Z'));
        expect((await store.plannerJobs.get('j1'))?.state).toBe('succeeded');
        const latest = await store.plannerJobs.list(
            { zoneId: 'z1' as PlannerJob['zoneId'], state: 'succeeded' },
            { orderBy: 'updatedAt', desc: true, limit: 1 },
        );
        expect(latest.map((j) => j.jobId)).toEqual(['j2']);
        expect((await store.plannerJobs.list({ incidentId: null })).length).toBe(3);
        await store.plannerJobs.remove('j3');
        expect(await store.plannerJobs.get('j3')).toBeNull();
        expect([
            await store.counters.next('incident'),
            await store.counters.next('incident'),
        ]).toEqual([1, 2]);
    });

    test('civilians are numbered, unique by email and filterable by zone', async () => {
        const store = prismaStore(prisma);
        const a = await store.civilians.create({ email: 'a@example.com', zipCode: '96761' });
        await expect(
            store.civilians.create({ email: 'a@example.com', zipCode: '96761' }),
        ).rejects.toBeInstanceOf(DuplicateError);
        const b = await store.civilians.create({ email: 'b@example.com', zipCode: '96761' });
        expect(b.number).toBeGreaterThan(a.number);
        const loc = { lat: 20.88, lng: -156.68 };
        await store.civilians.update(a.id, {
            zoneId: 'z1' as PlannerJob['zoneId'],
            civilianAreaId: 'area-1',
            location: loc,
        });
        expect(await store.civilians.list({ zoneId: 'z1' })).toMatchObject([
            { id: a.id, location: loc },
        ]);
        expect((await store.civilians.update(a.id, { location: null }))?.location).toBeNull();
        expect(
            await store.civilians.update('00000000-0000-0000-0000-000000000000', { notes: 'x' }),
        ).toBeNull();
    });
});
