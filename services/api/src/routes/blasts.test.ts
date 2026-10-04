import { expect, test, vi } from 'vitest';
import type { CreateBlastRequest } from '@ember/contracts';
import { buildApp } from '../app.js';
import { newSession } from '../auth.js';
import type { Db } from '../db.js';

type BlastRow = Record<string, unknown> & { state: string; audience: string };

const zoneId = '00000000-0000-4000-8000-000000000001';
const blastId = '00000000-0000-4000-8000-0000000000c1';
const operatorId = '00000000-0000-4000-8000-0000000000a1';
const now = new Date('2026-10-04T12:00:00Z');
const keys = { edge: 'edge-key', planner: 'planner-key' };
const session = newSession();
const asOperator = { authorization: `Bearer ${session.token}` };
const asService = { authorization: 'Bearer edge-key' };

function blastDb(stored: BlastRow[] = []) {
    const table = new Map(stored.map((b) => [b.id as string, b]));
    const stubs = {
        operatorSession: {
            findUnique: vi.fn<() => Promise<unknown>>(async () => ({
                expiresAt: session.expiresAt,
                operator: { id: operatorId, email: 'ana@example.com', name: 'Ana', createdAt: now },
            })),
        },
        blast: {
            create: vi.fn<(args: { data: BlastRow }) => Promise<unknown>>(async ({ data }) => {
                const row = {
                    id: blastId,
                    createdAt: now,
                    approvedBy: null,
                    approverName: null,
                    approvedAt: null,
                    ...data,
                };
                table.set(blastId, row);
                return row;
            }),
            updateMany: vi.fn<
                (args: { where: { id: string; state: string }; data: object }) => Promise<unknown>
            >(async ({ where, data }) => {
                const row = table.get(where.id);
                if (!row || row.state !== where.state) return { count: 0 };
                table.set(where.id, { ...row, ...data });
                return { count: 1 };
            }),
            findUnique: vi.fn<(args: { where: { id: string } }) => Promise<unknown>>(
                async ({ where }) => table.get(where.id) ?? null,
            ),
        },
    };
    return { db: stubs as unknown as Db, stubs, table };
}

const draft = (
    audience: CreateBlastRequest['audience'],
    approve?: boolean,
): CreateBlastRequest => ({
    audience,
    priority: 'urgent',
    area: 'near_fire',
    title: 'Evacuate now',
    body: 'Fire is moving toward Front Street. Leave by Honoapiilani Highway north.',
    ...(approve === undefined ? {} : { approve }),
});

const post = (db: Db, payload: CreateBlastRequest, headers: Record<string, string>) =>
    buildApp({ db, keys }).inject({
        method: 'POST',
        url: `/v1/watch-zones/${zoneId}/blasts`,
        payload,
        headers,
    });

test('no civilian blast is queued without an operator approving it', async () => {
    const drafts = (['civilians', 'both'] as const).flatMap((audience) =>
        [undefined, false, true].map((approve) => draft(audience, approve)),
    );
    const sent = await Promise.all(
        drafts.map(async (payload) => {
            const { db, stubs } = blastDb();
            return { res: await post(db, payload, asService), stubs };
        }),
    );
    for (const { res, stubs } of sent) {
        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({
            state: 'pending_approval',
            approval: null,
            createdBy: 'service',
        });
        expect(stubs.blast.create.mock.calls[0]![0].data).not.toHaveProperty('approvedBy');
    }
    const unapproved = await post(blastDb().db, draft('civilians'), asOperator);
    expect(unapproved.json()).toMatchObject({ state: 'pending_approval', createdBy: operatorId });
});

test('an operator approves in the same call; responder blasts queue at once', async () => {
    const approved = await post(blastDb().db, draft('both', true), asOperator);
    expect(approved.json()).toMatchObject({
        state: 'queued',
        createdBy: operatorId,
        approval: { approvedBy: operatorId, approverName: 'Ana' },
    });
    const responders = await post(blastDb().db, draft('responders'), asService);
    expect(responders.json()).toMatchObject({ state: 'queued', approval: null });
});

test('only an operator session approves a pending blast, once', async () => {
    const pending: BlastRow = {
        id: blastId,
        zoneId,
        audience: 'civilians',
        priority: 'critical',
        area: 'zone',
        title: 'Shelter in place',
        body: 'Stay indoors.',
        state: 'pending_approval',
        createdBy: 'service',
        createdAt: now,
        approvedBy: null,
        approverName: null,
        approvedAt: null,
    };
    const { db, stubs } = blastDb([pending]);
    const app = buildApp({ db, keys });
    const url = `/v1/blasts/${blastId}/approve`;
    const byService = await app.inject({ method: 'POST', url, headers: asService });
    expect(byService.statusCode).toBe(403);
    expect(stubs.blast.updateMany).not.toHaveBeenCalled();

    const first = await app.inject({ method: 'POST', url, headers: asOperator });
    expect(first.json()).toMatchObject({
        state: 'queued',
        approval: { approvedBy: operatorId, approverName: 'Ana' },
    });
    const again = await app.inject({ method: 'POST', url, headers: asOperator });
    expect(again.statusCode).toBe(200);
    expect(again.json().approval).toEqual(first.json().approval);
});
