import { ApiClient, OperatorRelay } from './api.js';
import { buildApp, type AppDeps } from './app.js';
import { LogTransport, type CivilianTransport } from './channels.js';
import { ChatHandler } from './chat.js';
import { configFromEnv } from './config.js';
import { describeError, type Ctx } from './context.js';
import { nominatim } from './geocode.js';
import { ClaudeReasoner } from './llm/claude.js';
import { GeminiMapImager } from './map/imagery.js';
import { MasterLoop } from './loop.js';
import { InMemory, PgMemory, type AgentMemory } from './memory.js';
import { PhotonTransport } from './photon.js';

const env = process.env;
const port = Number(env.PORT ?? 4006);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be 1-65535, got ${env.PORT}`);
}

const deps: AppDeps = { chat: null, memory: null, key: env.EMBER_AGENT_KEY };
const app = buildApp(deps);
const log = {
    info: (obj: object, msg: string) => app.log.info(obj, msg),
    warn: (obj: object, msg: string) => app.log.warn(obj, msg),
    error: (obj: object, msg: string) => app.log.error(obj, msg),
};

const config = configFromEnv(env);
const memory: AgentMemory = env.OPERATOR_AGENT_DATABASE_URL
    ? await PgMemory.connect(env.OPERATOR_AGENT_DATABASE_URL)
    : new InMemory();
if (!env.OPERATOR_AGENT_DATABASE_URL)
    log.warn({}, 'OPERATOR_AGENT_DATABASE_URL unset: decision log is in memory only');

const transport: CivilianTransport =
    env.PHOTON_PROJECT_ID && env.PHOTON_PROJECT_SECRET
        ? await PhotonTransport.connect(env.PHOTON_PROJECT_ID, env.PHOTON_PROJECT_SECRET)
        : new LogTransport((msg, data) => log.info(data, msg));

const api = new ApiClient(config.apiUrl, env.EMBER_AGENT_KEY);
const ctx: Ctx = {
    api,
    memory,
    reasoner: env.ANTHROPIC_API_KEY
        ? new ClaudeReasoner(env.EMBER_CLAUDE_MODEL ?? 'claude-haiku-4-5')
        : null,
    imager: env.GEMINI_API_KEY
        ? new GeminiMapImager(
              env.GEMINI_API_KEY,
              env.EMBER_GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image',
          )
        : null,
    transport,
    config,
    log,
    geocode: nominatim(env.EMBER_NOMINATIM_USER_AGENT ?? 'ember-operator-agent (dev)'),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
if (!ctx.reasoner)
    log.warn({}, 'ANTHROPIC_API_KEY unset: chat uses the rules router and templates');
if (!ctx.imager) log.warn({}, 'GEMINI_API_KEY unset: alert maps are sent as the plain render');

const chat = new ChatHandler(ctx, {
    relay: new OperatorRelay(config.apiUrl, env.EMBER_OPERATOR_RELAY_KEY),
    openOperator: env.EMBER_ASI1_OPEN_OPERATOR === 'true',
});
deps.chat = chat;
deps.memory = memory;

const loop = new MasterLoop(ctx);
const looping = env.EMBER_AGENT_LOOP !== 'off';
if (looping) loop.start();
deps.health = async () => {
    const apiUp = await fetch(`${config.apiUrl}/healthz`, { signal: AbortSignal.timeout(3_000) })
        .then((r) => r.ok)
        .catch(() => false);
    const tick = loop.lastTick;
    // A loop that has not finished a tick in five intervals is stuck.
    const loopOk =
        !looping ||
        (tick !== null && tick.ok && Date.now() - Date.parse(tick.at) < 5 * config.tickMs + 60_000);
    return {
        ok: apiUp && (loopOk || tick === null),
        api: apiUp,
        loop: looping ? { ...tick, healthy: loopOk } : 'off',
        reasoner: ctx.reasoner?.name ?? 'rules',
        imager: ctx.imager ? 'gemini' : 'render',
        transport: transport.name,
        memory: memory instanceof PgMemory ? 'postgres' : 'in-process',
    };
};

const inbound = transport.inbound();
if (inbound) {
    void (async () => {
        for await (const text of inbound) {
            try {
                await api.recordInbound(text);
            } catch (err) {
                log.warn(
                    { handle: text.handle, err: describeError(err) },
                    'inbound text not recorded',
                );
                if (config.signupUrl) {
                    await transport
                        .send(
                            text.handle,
                            `This is Ember wildfire alerts. Sign up at ${config.signupUrl} to get alerts for your area.`,
                        )
                        .catch(() => {});
                }
            }
        }
    })();
}

app.addHook('onClose', async () => {
    loop.stop();
    await transport.close();
    if (memory instanceof PgMemory) await memory.close();
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
