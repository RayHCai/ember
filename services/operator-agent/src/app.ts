import Fastify from 'fastify';
import { AGENT_CHAT_PATH, SERVICE_HEALTH_PATH, type AgentChatRequest } from '@ember/contracts';
import { answer } from './chat.js';
import type { ZoneStatus } from './incidents.js';

export type AppDeps = {
    /** What the incident loop last saw per zone. */
    statuses: () => ZoneStatus[];
    /** Bearer `/v1/chat` requires; unset accepts anything (development). */
    chatKey: string | undefined;
    /** Deep health; without it `/healthz` only says the process is up. */
    health?: () => Promise<{ ok: boolean } & Record<string, unknown>>;
};

const chatBody = {
    type: 'object',
    required: ['channel', 'sender', 'sessionId', 'text', 'sentAt'],
    properties: {
        channel: { enum: ['asi1', 'dashboard'] },
        sender: { type: 'string', minLength: 1, maxLength: 300 },
        sessionId: { type: 'string', minLength: 1, maxLength: 300 },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        sentAt: { type: 'string' },
    },
} as const;

export function buildApp(deps: AppDeps = { statuses: () => [], chatKey: undefined }) {
    const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
    app.get(SERVICE_HEALTH_PATH, async (_req, reply) => {
        if (!deps.health) return { service: 'operator-agent', ok: true };
        const health = await deps.health();
        return reply.code(health.ok ? 200 : 503).send({ service: 'operator-agent', ...health });
    });

    app.post<{ Body: AgentChatRequest }>(
        AGENT_CHAT_PATH,
        { schema: { body: chatBody } },
        async (req, reply) => {
            if (deps.chatKey && req.headers.authorization !== `Bearer ${deps.chatKey}`) {
                return reply.code(401).send({ error: 'agent chat key required' });
            }
            return answer(req.body, deps.statuses());
        },
    );
    return app;
}
