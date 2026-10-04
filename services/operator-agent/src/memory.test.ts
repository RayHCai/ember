import { afterAll, describe, expect, test } from 'vitest';
import { InMemory, PgMemory, type AgentMemory } from './memory.js';

// The Postgres half needs a database: `EMBER_TEST_DATABASE_URL=... pnpm --filter @ember/operator-agent test`.
const url = process.env.EMBER_TEST_DATABASE_URL;
const stores: [string, () => Promise<AgentMemory>][] = [['memory', async () => new InMemory()]];
if (url) stores.push(['postgres', () => PgMemory.connect(url)]);
const opened: PgMemory[] = [];
afterAll(async () => {
    for (const m of opened) await m.close();
});

describe.each(stores)('%s', (_name, open) => {
    test('decisions, turns, notes, pending work and state round-trip', async () => {
        const m = await open();
        if (m instanceof PgMemory) opened.push(m);
        const zoneId = `z-${crypto.randomUUID()}`;
        const base = {
            zoneId,
            incidentId: null,
            domain: 'prevention' as const,
            kind: 'scan_cadence',
            reason: 'r',
            inputs: [{ kind: 'weather' as const, id: 'w', note: 'n' }],
            confidence: 0.7,
            actions: ['a'],
        };
        const first = await m.addDecision({ ...base, summary: 'one' }, '2026-10-03T12:00:00.000Z');
        const second = await m.addDecision({ ...base, summary: 'two' }, '2026-10-03T12:01:00.000Z');
        expect(second.number).toBeGreaterThan(first.number);
        expect((await m.decision(String(second.number)))?.summary).toBe('two');
        expect((await m.decision(first.id))?.inputs).toEqual(base.inputs);
        expect((await m.decisions({ zoneId })).map((d) => d.summary)).toEqual(['two', 'one']);

        const session = `s-${crypto.randomUUID()}`;
        await m.appendTurn(session, { role: 'user', text: 'hi', at: '2026-10-03T12:00:00.000Z' });
        await m.appendTurn(session, {
            role: 'agent',
            text: 'hello',
            at: '2026-10-03T12:00:01.000Z',
        });
        expect((await m.turns(session, 1)).map((t) => t.text)).toEqual(['hello']);

        await m.addCivilianNote(session, 'two cats', '2026-10-03T12:00:00.000Z');
        expect(await m.civilianNotes(session)).toEqual(['two cats']);

        await m.addPending({
            jobId: session,
            zoneId,
            kind: 'risk',
            incidentId: null,
            data: { reason: 'x' },
            createdAt: '',
        });
        expect((await m.pending()).some((p) => p.jobId === session)).toBe(true);
        await m.removePending(session);
        expect((await m.pending()).some((p) => p.jobId === session)).toBe(false);

        await m.setState(`k-${session}`, { due: 'now' });
        expect(await m.getState(`k-${session}`)).toEqual({ due: 'now' });
    });
});
