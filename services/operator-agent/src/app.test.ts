import { expect, test } from 'vitest';
import { buildApp } from './app.js';
import type { ZoneStatus } from './incidents.js';
import { result, T0, zone } from './testing/fake.js';

test('health', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ service: 'operator-agent', ok: true });
});

const burning: ZoneStatus = {
    zone,
    onFire: 2,
    since: T0,
    plan: { jobId: 'job-1', state: 'succeeded' },
    responders: result.attackZones.filter((z) => z.rank === 1),
    evacuations: [
        {
            blastId: 'b-1',
            zipCode: '96761',
            title: 'Evacuation ZIP 96761: Kahana',
            state: 'pending_approval',
            delivered: null,
        },
        {
            blastId: 'b-2',
            zipCode: '96767',
            title: 'Evacuation ZIP 96767: Front Street',
            state: 'queued',
            delivered: { sent: 4, failed: 1 },
        },
    ],
    unplaced: ['Olowalu'],
    checkedAt: T0,
};

const chat = (text: string, key = 'ck') => ({
    method: 'POST' as const,
    url: '/v1/chat',
    headers: { authorization: `Bearer ${key}` },
    payload: { channel: 'asi1', sender: 'agent1q', sessionId: 's', text, sentAt: T0 },
});

test('chat needs the chat key', async () => {
    const app = buildApp({ statuses: () => [burning], chatKey: 'ck' });
    const [wrong, right] = await Promise.all([
        app.inject(chat('status', 'nope')),
        app.inject(chat('status')),
    ]);
    expect([wrong.statusCode, right.statusCode]).toEqual([401, 200]);
});

test('chat reports the incident, responder staging and evacuation alerts', async () => {
    const app = buildApp({ statuses: () => [burning], chatKey: 'ck' });
    const reply = (await app.inject(chat('status'))).json();
    expect(reply.text).toBe('Fire detected in Lahaina.');
    expect(reply.cards.map((c: { kind: string }) => c.kind)).toEqual([
        'incident',
        'responder_plan',
        'evacuation',
    ]);
    expect(reply.cards[1].markdown).toContain('1. indirect attack, drop site 20.91000, -156.66000');
    expect(reply.cards[2].markdown).toBe(
        [
            '- ZIP 96761: waiting for operator approval',
            '- ZIP 96767: sent to 4, 1 failed',
            '- No ZIP found for Olowalu: not drafted',
        ].join('\n'),
    );
});

test('chat with no fire, and a malformed request', async () => {
    const calm = { ...burning, onFire: 0, responders: [], evacuations: [], unplaced: [] };
    const app = buildApp({ statuses: () => [calm], chatKey: undefined });
    expect((await app.inject(chat('anything in lahaina?'))).json()).toEqual({
        text: 'No fire detected in Lahaina.',
        cards: [],
    });
    const bad = await app.inject({ ...chat('x'), payload: { text: 'x' } });
    expect(bad.statusCode).toBe(400);
});
