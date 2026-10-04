import cors from '@fastify/cors';
import Fastify from 'fastify';
import { SERVICE_HEALTH_PATH } from '@ember/contracts';
import { authenticate, requireBearer, type ApiKeys } from './auth.js';
import type { Db } from './db.js';
import type { EdgeManager } from './edgeManager.js';
import type { OpenData } from './openData/types.js';
import type { PlannerQueue } from './queue.js';
import { signInRoutes, sessionRoutes } from './routes/auth.js';
import { blastRoutes } from './routes/blasts.js';
import { civilianDirectoryRoutes, civilianRoutes } from './routes/civilians.js';
import { detectionRoutes } from './routes/detections.js';
import { droneRoutes } from './routes/drones.js';
import { edgeServerRoutes } from './routes/edgeServers.js';
import { mappingRunRoutes } from './routes/mappingRuns.js';
import { placementRoutes } from './routes/placements.js';
import { plannerJobRoutes, plannerRoutes } from './routes/planner.js';
import { riskZoneRoutes } from './routes/riskZones.js';
import { scanRoutes } from './routes/scans.js';
import { surroundingsRoutes } from './routes/surroundings.js';
import { watchZoneRoutes } from './routes/watchZones.js';
import { zoneSummaryRoutes } from './routes/zoneSummaries.js';
import { createSurroundings } from './surroundings.js';

export type AppDeps = {
    db: Db;
    queue?: PlannerQueue | null;
    keys?: ApiKeys;
    edgeManager?: EdgeManager | null;
    /** Null turns forest fit, surroundings and weather off. */
    openData?: OpenData | null;
    /** Browser origins allowed besides localhost and the Tauri webview (`EMBER_API_ORIGINS`). */
    origins?: string[];
};

// The dashboard in dev (vite on any port) and inside the Tauri webview on each platform.
const LOCAL_ORIGIN =
    /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/;

export function allowedOrigin(origin: string, extra: string[] = []): boolean {
    return LOCAL_ORIGIN.test(origin) || extra.includes(origin);
}

export function buildApp({
    db,
    queue = null,
    keys = {},
    edgeManager = null,
    openData = null,
    origins = [],
}: AppDeps) {
    const app = Fastify({
        logger: process.env.NODE_ENV !== 'test',
        bodyLimit: 16 * 1024 * 1024,
    });
    app.register(cors, {
        origin: (origin, done) =>
            done(null, origin !== undefined && allowedOrigin(origin, origins)),
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
    });
    app.decorateRequest('caller', null);
    const surroundings = createSurroundings({ db, openData, log: app.log });

    app.get(SERVICE_HEALTH_PATH, async () => ({ service: 'api', ok: true }));
    civilianRoutes(app, db);
    signInRoutes(app, db);
    app.register(async (scope) => {
        scope.addHook('preHandler', authenticate(db, keys));
        sessionRoutes(scope, db);
        zoneSummaryRoutes(scope, { db, edgeManager });
        watchZoneRoutes(scope, { db, surroundings });
        edgeServerRoutes(scope, { db, edgeManager });
        placementRoutes(scope, { db, edgeManager });
        droneRoutes(scope, db);
        scanRoutes(scope, { db, edgeManager });
        mappingRunRoutes(scope, db);
        detectionRoutes(scope, db);
        riskZoneRoutes(scope, db);
        surroundingsRoutes(scope, { db, openData, surroundings });
        plannerJobRoutes(scope, db, queue);
        blastRoutes(scope, db);
        civilianDirectoryRoutes(scope, db);
    });
    app.register(async (scope) => {
        scope.addHook('preHandler', requireBearer([keys.planner]));
        plannerRoutes(scope, { db, openData });
    });
    return app;
}
