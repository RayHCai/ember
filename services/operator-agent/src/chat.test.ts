import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { Approval, WatchZone } from '@ember/contracts';
import { ApiError, OperatorRelay } from './api.js';
import { buildApp } from './app.js';
import { ChatHandler } from './chat.js';
import { ClaudeReasoner } from './llm/claude.js';
import type { Reasoner } from './llm/reasoner.js';
import { context } from './testing/fixtures.js';

type CreateArgs = {
    messages: { role: string; content: unknown }[];
    tools?: unknown[];
    system?: unknown;
};

function fakeMessages(responses: object[], parsed?: unknown) {
    const calls: CreateArgs[] = [];
    return {
        calls,
        messages: {
            create: async (args: CreateArgs) => {
                calls.push(structuredClone(args));
                return responses.shift() as never;
            },
            parse: async () => ({ stop_reason: 'end_turn', parsed_output: parsed }) as never,
        } as unknown as ConstructorParameters<typeof ClaudeReasoner>[1],
    };
}

describe('claude reasoner', () => {
    test('runs the tools Claude calls and returns its final text', async () => {
        const fake = fakeMessages([
            {
                stop_reason: 'tool_use',
                content: [
                    { type: 'text', text: 'Checking.' },
                    {
                        type: 'tool_use',
                        id: 't1',
                        name: 'rank_regions',
                        input: { zone: 'Lahaina' },
                    },
                ],
            },
            {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Sector S1 is highest (0.58).' }],
            },
        ]);
        const claude = new ClaudeReasoner('claude-haiku-4-5', fake.messages);
        const ran: unknown[] = [];
        const out = await claude.converse({
            system: 'sys',
            history: [{ role: 'agent', text: 'earlier', at: '' }],
            text: 'Where is the risk?',
            tools: [{ name: 'rank_regions', description: 'd', parameters: { type: 'object' } }],
            run: async (name, args) => {
                ran.push([name, args]);
                return { summary: 'S1 0.58' };
            },
        });
        expect(out.text).toBe('Sector S1 is highest (0.58).');
        expect(ran).toEqual([['rank_regions', { zone: 'Lahaina' }]]);
        const second = fake.calls[1]!.messages;
        expect(second[0]).toEqual({ role: 'user', content: 'Where is the risk?' });
        expect(second.at(-1)).toEqual({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"summary":"S1 0.58"}' }],
        });
        expect(fake.calls[0]!.tools).toEqual([
            { name: 'rank_regions', description: 'd', input_schema: { type: 'object' } },
        ]);
    });

    test('a failing tool goes back to Claude as an error result', async () => {
        const fake = fakeMessages([
            {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
            },
            { stop_reason: 'end_turn', content: [{ type: 'text', text: 'It failed.' }] },
        ]);
        await new ClaudeReasoner('m', fake.messages).converse({
            system: '',
            history: [],
            text: 'go',
            tools: [],
            run: async () => ({ error: 'down' }),
        });
        expect(
            (fake.calls[1]!.messages.at(-1)!.content as { is_error?: boolean }[])[0]!.is_error,
        ).toBe(true);
    });

    test('structured answers are validated before anyone acts on them', async () => {
        const schema = z.object({ roadName: z.string(), state: z.enum(['blocked', 'open']) });
        const ok = new ClaudeReasoner(
            'm',
            fakeMessages([], { roadName: 'Ridge Rd', state: 'blocked' }).messages,
        );
        expect(await ok.structured({ system: '', prompt: '', schema })).toEqual({
            roadName: 'Ridge Rd',
            state: 'blocked',
        });
        const bad = new ClaudeReasoner(
            'm',
            fakeMessages([], { roadName: 'Ridge Rd', state: 'maybe' }).messages,
        );
        await expect(bad.structured({ system: '', prompt: '', schema })).rejects.toThrow(
            /Invalid option/,
        );
        const none = new ClaudeReasoner('m', fakeMessages([], null).messages);
        await expect(none.structured({ system: '', prompt: '', schema })).rejects.toThrow(
            'no structured answer',
        );
    });
});

const LAHAINA = {
    id: 'z1',
    name: 'Lahaina',
    areaHa: 1200,
    center: { lat: 0, lng: 0 },
    surveillance: null,
} as unknown as WatchZone;

function approval(state: Approval['state'] = 'pending'): Approval {
    return {
        id: 'ap7',
        number: 7,
        zoneId: 'z1',
        incidentId: null,
        state,
        reason: 'Bypass Homes warning',
        confirmationCode: 'K3QF',
        draft: {
            kind: 'civilian_alert',
            jobId: 'j',
            civilianAreaId: 'a',
            severity: 'warning',
            recipients: [{ civilianId: 'c', body: 'b' }],
            mapUrl: null,
        },
    } as Approval;
}

function chat(
    opts: { relayKey?: string; reasoner?: Reasoner; open?: boolean; decide?: typeof fetch } = {},
) {
    const ctx = context(
        { zones: async () => [LAHAINA], approvals: async () => [approval()] },
        opts.reasoner ? { reasoner: opts.reasoner } : {},
    );
    const relay = new OperatorRelay('http://api.test', opts.relayKey, opts.decide);
    return { ctx, handler: new ChatHandler(ctx, { relay, openOperator: opts.open ?? false }) };
}

const ask = (text: string, sender = 'agent1qoperator') => ({
    channel: 'asi1' as const,
    sender,
    sessionId: 's',
    text,
    sentAt: '2026-10-03T12:00:00Z',
});

describe('chat', () => {
    test('approvals need an allow-listed operator, an enabled relay and the code', async () => {
        expect(
            (
                await chat({ relayKey: 'ok' }).handler.handle(
                    ask('approve 7 K3QF', 'agent1qstranger'),
                )
            ).text,
        ).toBe('Only an Ember operator can decide approvals.');
        expect((await chat().handler.handle(ask('approve 7 K3QF'))).text).toContain('not enabled');
        const bodies: unknown[] = [];
        const decide = (async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            return Response.json({ ...approval('approved'), decidedBy: 'x' });
        }) as typeof fetch;
        const { handler, ctx } = chat({ relayKey: 'ok', decide });
        const reply = await handler.handle(ask('approve 7 k3qf'));
        expect(reply.text).toContain('Approval 7 approved');
        expect(bodies).toEqual([
            {
                decision: 'approve',
                operator: 'asi1:agent1qoperator',
                confirmationCode: 'K3QF',
                via: 'asi1',
            },
        ]);
        expect((await ctx.memory.decisions({}))[0]).toMatchObject({
            kind: 'operator_decision',
            confidence: 1,
        });
    });

    test('open demo mode: anyone may approve while texts cannot reach a phone, and mentions are ignored', async () => {
        const bodies: unknown[] = [];
        const decide = (async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            return Response.json({ ...approval('approved') });
        }) as typeof fetch;
        const { handler, ctx } = chat({ relayKey: 'ok', decide, open: true });
        const reply = await handler.handle(
            ask('@agent1qdxvsh9u6apatpn78dew2lvcv please approve 7 K3QF thanks', 'agent1qjudge'),
        );
        expect(reply.text).toContain('Approval 7 approved');
        expect(bodies).toHaveLength(1);
        ctx.transport = { ...ctx.transport, name: 'photon-imessage' } as typeof ctx.transport;
        const blocked = await handler.handle(ask('approve 7 K3QF', 'agent1qjudge'));
        expect(blocked.text).toContain('only an allow-listed Ember operator');
        expect(bodies).toHaveLength(1);
    });

    test('a wrong code is reported, not approved', async () => {
        const decide = (async () =>
            Response.json(
                { error: 'wrong confirmation code for approval 7' },
                { status: 409 },
            )) as unknown as typeof fetch;
        const reply = await chat({ relayKey: 'ok', decide }).handler.handle(ask('approve 7 ZZZZ'));
        expect(reply.text).toContain('was not recorded');
        expect(reply.toolCalls).toEqual([{ name: 'approval_decision', ok: false }]);
    });

    test('the public cannot use acting tools, even if the model asks', async () => {
        const reasoner: Reasoner = {
            name: 'fake',
            structured: async () => {
                throw new Error('unused');
            },
            converse: async (req) => {
                expect(req.tools.map((t) => t.name)).not.toContain('simulate_fire');
                const r = (await req.run('simulate_fire', { sector: 'S7' })) as { error?: string };
                return { text: r.error ?? 'ran' };
            },
        };
        const reply = await chat({ reasoner }).handler.handle(
            ask('Simulate a fire', 'agent1qstranger'),
        );
        expect(reply.text).toBe('operator only');
        expect(reply.toolCalls).toEqual([{ name: 'simulate_fire', ok: false }]);
    });

    test('without a model, the rules router answers from tools', async () => {
        const reply = await chat().handler.handle(ask('List the watch zones'));
        expect(reply.text).toBe('Lahaina (1200 ha)');
        expect(reply.toolCalls).toEqual([{ name: 'get_watch_zones', ok: true }]);
    });

    test('a failing tool comes back as an error the reply can state', async () => {
        const ctx = context({
            zones: async () => {
                throw new ApiError(503, 'GET /v1/watch-zones', { error: 'down' });
            },
        });
        const reply = await new ChatHandler(ctx, {
            relay: new OperatorRelay('x', undefined),
            openOperator: true,
        }).handle(ask('List the watch zones'));
        expect(reply.text).toBe('get_watch_zones failed: api GET /v1/watch-zones: 503 down');
    });
});

test('chat route checks the agent key and the body', async () => {
    const { handler } = chat();
    const app = buildApp({ chat: handler, memory: null, key: 'ak' });
    const post = (headers: Record<string, string>, payload: object) =>
        app.inject({ method: 'POST', url: '/v1/chat', headers, payload });
    expect((await post({}, ask('hi'))).statusCode).toBe(401);
    expect((await post({ authorization: 'Bearer ak' }, { text: 'hi' })).statusCode).toBe(400);
    expect(
        (await post({ authorization: 'Bearer ak' }, ask('List the watch zones'))).json().text,
    ).toBe('Lahaina (1200 ha)');
});
