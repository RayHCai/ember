import { config } from 'dotenv';
import { buildApp } from './app.js';
import { createPrisma } from './db.js';
import { createEdgeManager } from './edgeManager.js';
import { createOpenData } from './openData/index.js';
import { redisPlannerQueue } from './queue.js';
import { startScheduler } from './scheduler.js';

config();

const port = Number(process.env.PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be 1-65535, got ${process.env.PORT}`);
}

const keys = {
    edge: process.env.EMBER_EDGE_KEY || undefined,
    planner: process.env.EMBER_PLANNER_KEY || undefined,
    agent: process.env.EMBER_AGENT_KEY || undefined,
};
const redisUrl = process.env.EMBER_REDIS_URL || undefined;
const edgeManagerUrl = process.env.EMBER_EDGE_MANAGER_URL || undefined;
const origins = (process.env.EMBER_API_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
const openDataOff = process.env.EMBER_OPEN_DATA === 'off';

const REDIS_LOG_EVERY_MS = 30_000;
let redisLoggedAt = 0;
const queue = redisUrl
    ? redisPlannerQueue(redisUrl, (err) => {
          if (Date.now() - redisLoggedAt < REDIS_LOG_EVERY_MS) return;
          redisLoggedAt = Date.now();
          app.log.warn({ err }, 'planner queue: redis unreachable');
      })
    : null;
const edgeManager = edgeManagerUrl
    ? createEdgeManager({ url: edgeManagerUrl, key: keys.edge })
    : null;
const openData = openDataOff
    ? null
    : createOpenData({
          overpassUrl: process.env.EMBER_OVERPASS_URL || undefined,
          openMeteoUrl: process.env.EMBER_OPEN_METEO_URL || undefined,
      });

const prisma = createPrisma();
const app = buildApp({ db: prisma, queue, keys, edgeManager, openData, origins });
if (!keys.edge && !keys.planner && !keys.agent) {
    app.log.warn(
        'EMBER_EDGE_KEY, EMBER_PLANNER_KEY and EMBER_AGENT_KEY unset: every route accepts any caller',
    );
} else if (!keys.planner) {
    app.log.warn('EMBER_PLANNER_KEY unset: the planner routes accept any caller');
}
if (!queue) app.log.warn('EMBER_REDIS_URL unset: planner jobs cannot be queued');
if (!edgeManager) app.log.warn('EMBER_EDGE_MANAGER_URL unset: scans cannot start');
if (!openData) app.log.warn('EMBER_OPEN_DATA=off: no forest fit, surroundings or weather');

const scheduler = startScheduler({ db: prisma, edgeManager }, app.log);
app.addHook('onClose', async () => {
    scheduler.stop();
    await queue?.close();
    await prisma.$disconnect();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        app.close().then(
            () => process.exit(0),
            (err: unknown) => {
                app.log.error(err, 'shutdown failed');
                process.exit(1);
            },
        );
    });
}
await app.listen({ port, host: '0.0.0.0' });
