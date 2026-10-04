import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { SERVICE_HEALTH_PATH } from '@ember/contracts';
import { Fleet } from './fleet.js';
import { ingestRoutes } from './routes/ingest.js';
import { streamRoutes } from './routes/stream.js';

export type AppOptions = { fleet?: Fleet; fleetIntervalMs?: number };

export function buildApp(options: AppOptions = {}) {
    const fleet = options.fleet ?? new Fleet();
    const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 16 * 1024 * 1024 });
    app.get(SERVICE_HEALTH_PATH, async () => ({ service: 'drone-info', ok: true }));
    app.register(websocket);
    app.register(async (scope) => {
        ingestRoutes(scope, fleet);
        streamRoutes(scope, fleet, options.fleetIntervalMs ?? 1000);
    });
    return app;
}
