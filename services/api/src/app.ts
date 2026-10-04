import Fastify from 'fastify';
import { SERVICE_HEALTH_PATH } from '@ember/contracts';
import type { Deps } from './deps.js';
import { errorHandler } from './errors.js';
import { approvalRoutes } from './routes/approvals.js';
import { civilianRoutes } from './routes/civilians.js';
import { detectionRoutes } from './routes/detections.js';
import { incidentRoutes } from './routes/incidents.js';
import { plannerRoutes } from './routes/planner.js';
import { responderRoutes } from './routes/responders.js';
import { scanRoutes } from './routes/scans.js';
import { zoneRoutes } from './routes/zones.js';

export function buildApp(deps: Deps) {
    // Planner results carry a per-cell arrival grid, up to 40,000 cells.
    const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 16 * 1024 * 1024 });
    errorHandler(app);
    app.get(SERVICE_HEALTH_PATH, async () => ({ service: 'api', ok: true }));
    civilianRoutes(app, deps);
    zoneRoutes(app, deps);
    detectionRoutes(app, deps);
    scanRoutes(app, deps);
    plannerRoutes(app, deps);
    incidentRoutes(app, deps);
    approvalRoutes(app, deps);
    responderRoutes(app, deps);
    return app;
}
