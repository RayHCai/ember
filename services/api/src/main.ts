import { config } from 'dotenv';
import { buildApp } from './app.js';
import { keysFromEnv, type Role } from './auth.js';
import { createPrisma } from './db.js';
import type { Deps } from './deps.js';
import { HttpEdgeManager, RedisPlannerQueue } from './integrations.js';
import { memoryStore } from './store/index.js';
import { prismaStore } from './store/prisma.js';
import {
    DemoDataWeather,
    FixtureWeather,
    NwsWeather,
    ScenarioClock,
    type WeatherProvider,
} from './weather.js';

config();

const env = process.env;
const port = Number(env.PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be 1-65535, got ${env.PORT}`);
}

function weatherProvider(): WeatherProvider {
    const kind = env.EMBER_WEATHER_PROVIDER ?? 'fixture';
    if (kind === 'demo-data') {
        return new DemoDataWeather(env.EMBER_DEMO_DATA_URL ?? 'http://localhost:8090');
    }
    if (kind === 'nws') return new NwsWeather(env.EMBER_NWS_USER_AGENT ?? 'ember (dev)');
    if (kind !== 'fixture') throw new Error(`EMBER_WEATHER_PROVIDER: unknown ${kind}`);
    const start = new Date(env.EMBER_SCENARIO_START ?? '2023-08-08T12:00:00-10:00');
    const speed = Number(env.EMBER_SCENARIO_SPEED ?? 30);
    if (Number.isNaN(start.getTime()) || !(speed > 0)) {
        throw new Error('EMBER_SCENARIO_START must be ISO 8601 and EMBER_SCENARIO_SPEED > 0');
    }
    return new FixtureWeather(new ScenarioClock(start, speed));
}

const prisma = env.EMBER_API_STORE === 'memory' ? null : createPrisma();
const keys = keysFromEnv(env);
const deps: Deps = {
    store: prisma ? prismaStore(prisma) : memoryStore(),
    queue: new RedisPlannerQueue(env.EMBER_REDIS_URL ?? 'redis://localhost:6379/0'),
    edge: new HttpEdgeManager(
        env.EMBER_EDGE_MANAGER_URL ?? 'http://localhost:8060',
        env.EMBER_EDGE_KEY,
    ),
    weather: weatherProvider(),
    keys,
    config: {
        publicApiUrl: env.EMBER_PUBLIC_API_URL ?? `http://localhost:${port}`,
        droneInfoUrl: env.EMBER_PUBLIC_DRONE_INFO_URL ?? null,
        scanCellSizeM: Number(env.EMBER_SCAN_CELL_M ?? 10),
    },
    now: () => new Date(),
};

const app = buildApp(deps);
const open = (['operator', 'agent', 'planner', 'ingest'] as Role[]).filter((r) => !keys[r]);
if (open.length) app.log.warn({ roles: open }, 'no key set for these roles: their routes are open');
if (!prisma) app.log.warn('EMBER_API_STORE=memory: records are lost on restart');
app.addHook('onClose', async () => {
    await deps.queue.close();
    await prisma?.$disconnect();
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
