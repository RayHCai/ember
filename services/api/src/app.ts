import Fastify from 'fastify';
import { SERVICE_HEALTH_PATH } from '@ember/contracts';
import type { Db } from './db.js';
import { civilianRoutes } from './routes/civilians.js';

export function buildApp(db: Db) {
    const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
    app.get(SERVICE_HEALTH_PATH, async () => ({ service: 'api', ok: true }));
    civilianRoutes(app, db);
    return app;
}
