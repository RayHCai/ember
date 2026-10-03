import Fastify from 'fastify';
import { SERVICE_HEALTH_PATH } from '@ember/contracts';

export function buildApp() {
    const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
    app.get(SERVICE_HEALTH_PATH, async () => ({ service: 'civilian-agent', ok: true }));
    return app;
}
