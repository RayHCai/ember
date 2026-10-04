import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
    AGENT_CHAT_PATH,
    AGENT_DECISION_PATH,
    AGENT_DECISIONS_PATH,
    SERVICE_HEALTH_PATH,
    type AgentChatRequest,
} from '@ember/contracts';
import type { ChatHandler } from './chat.js';
import type { AgentMemory } from './memory.js';

const chatBody = z.object({
    channel: z.enum(['asi1', 'dashboard']),
    sender: z.string().min(1).max(300),
    sessionId: z.string().min(1).max(300),
    text: z.string().min(1).max(4000),
    sentAt: z.string(),
});

const decisionsQuery = z.object({
    zoneId: z.string().optional(),
    incidentId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type AppDeps = {
    chat: ChatHandler | null;
    memory: AgentMemory | null;
    /** Bearer the uAgent bridge and dashboard send; unset accepts anything (development). */
    key: string | undefined;
    /** Deep health; without it `/healthz` only says the process is up. */
    health?: () => Promise<{ ok: boolean } & Record<string, unknown>>;
};

export function buildApp(deps: AppDeps = { chat: null, memory: null, key: undefined }) {
    const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
    app.get(SERVICE_HEALTH_PATH, async (_req, reply) => {
        if (!deps.health) return { service: 'operator-agent', ok: true };
        const health = await deps.health();
        return reply.code(health.ok ? 200 : 503).send({ service: 'operator-agent', ...health });
    });

    const authorized = (req: FastifyRequest) =>
        !deps.key || req.headers.authorization === `Bearer ${deps.key}`;

    app.post(AGENT_CHAT_PATH, async (req, reply) => {
        if (!authorized(req)) return reply.code(401).send({ error: 'agent key required' });
        if (!deps.chat) return reply.code(503).send({ error: 'agent not configured' });
        const body = chatBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
        return deps.chat.handle(body.data as AgentChatRequest);
    });

    app.get(AGENT_DECISIONS_PATH, async (req, reply) => {
        if (!authorized(req)) return reply.code(401).send({ error: 'agent key required' });
        if (!deps.memory) return reply.code(503).send({ error: 'agent not configured' });
        const q = decisionsQuery.safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message });
        return deps.memory.decisions(q.data);
    });

    app.get<{ Params: { decisionId: string } }>(AGENT_DECISION_PATH, async (req, reply) => {
        if (!authorized(req)) return reply.code(401).send({ error: 'agent key required' });
        if (!deps.memory) return reply.code(503).send({ error: 'agent not configured' });
        const d = await deps.memory.decision(req.params.decisionId);
        return d ?? reply.code(404).send({ error: `no decision ${req.params.decisionId}` });
    });
    return app;
}
