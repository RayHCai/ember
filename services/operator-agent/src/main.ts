import { HttpApi } from './api.js';
import { buildApp } from './app.js';
import { LogTransport, type CivilianTransport } from './channels.js';
import { configFromEnv } from './config.js';
import { nominatimZip } from './geo.js';
import { IncidentLoop } from './incidents.js';
import { PhotonTransport } from './photon.js';

const env = process.env;
const port = Number(env.PORT ?? 4006);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be 1-65535, got ${env.PORT}`);
}
const config = configFromEnv(env);

const deps: Parameters<typeof buildApp>[0] = { statuses: () => [], chatKey: config.chatKey };
const app = buildApp(deps);
const log = {
    info: (obj: object, msg: string) => app.log.info(obj, msg),
    warn: (obj: object, msg: string) => app.log.warn(obj, msg),
};

const transport: CivilianTransport =
    env.PHOTON_PROJECT_ID && env.PHOTON_PROJECT_SECRET
        ? await PhotonTransport.connect(env.PHOTON_PROJECT_ID, env.PHOTON_PROJECT_SECRET)
        : new LogTransport((msg, data) => log.info(data, msg));
if (transport instanceof LogTransport) {
    log.warn({}, 'PHOTON_PROJECT_ID unset: approved evacuation texts are logged, not sent');
}
if (!config.apiKey) log.warn({}, 'EMBER_AGENT_KEY unset: the api must run without keys');
if (!config.chatKey) log.warn({}, 'EMBER_AGENT_CHAT_KEY unset: /v1/chat accepts any caller');

const loop = new IncidentLoop({
    api: new HttpApi(config.apiUrl, config.apiKey),
    transport,
    zipOf: nominatimZip(env.EMBER_NOMINATIM_USER_AGENT ?? 'ember-operator-agent (dev)'),
    config,
    log,
});
deps.statuses = () => [...loop.status.values()];
deps.health = async () => {
    const apiUp = await fetch(`${config.apiUrl}/healthz`, { signal: AbortSignal.timeout(3_000) })
        .then((r) => r.ok)
        .catch(() => false);
    const tick = loop.lastTick;
    // A loop that has not finished a tick in five intervals is stuck.
    const loopOk =
        tick === null || (tick.ok && Date.now() - Date.parse(tick.at) < 5 * config.tickMs + 60_000);
    return { ok: apiUp && loopOk, api: apiUp, loop: tick, transport: transport.name };
};
loop.start();

app.addHook('onClose', async () => {
    loop.stop();
    await transport.close();
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
