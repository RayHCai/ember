import Anthropic from '@anthropic-ai/sdk';
import { HttpApi } from './api.js';
import { buildApp } from './app.js';
import { LogTransport, type CivilianTransport } from './channels.js';
import { configFromEnv } from './config.js';
import { nominatimZip } from './geo.js';
import { IncidentLoop } from './incidents.js';
import { osmTiles } from './map.js';
import { Notices } from './notices.js';
import { PhotonTransport } from './photon.js';
import { haikuRouteAsk, Reroute } from './reroute.js';

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

const api = new HttpApi(config.apiUrl, config.apiKey);
const osmAgent = env.EMBER_OSM_USER_AGENT ?? 'ember-operator-agent (dev)';
const notices = config.notifyPhone
    ? new Notices({
          api,
          transport,
          phone: config.notifyPhone,
          tiles: osmTiles(osmAgent, env.EMBER_MAP_TILE_URL || undefined),
          timeZone: config.timeZone,
          log,
      })
    : null;
if (notices) log.info({ phone: config.notifyPhone }, 'evacuation plans go to the notify phone');
if (config.notifyPhone && transport instanceof PhotonTransport) {
    if (env.ANTHROPIC_API_KEY) {
        const reroute = new Reroute({
            api,
            transport,
            phone: config.notifyPhone,
            wantsNewRoute: haikuRouteAsk(new Anthropic(), log),
            log,
        });
        transport.listen((from, text) =>
            reroute
                .handle(from, text)
                .catch((err: unknown) =>
                    log.warn(
                        { err: err instanceof Error ? err.message : String(err) },
                        'reroute failed',
                    ),
                ),
        );
        log.info({}, 'texts from the notify phone asking for a new route are planned and sent');
    } else {
        log.warn({}, 'ANTHROPIC_API_KEY unset: new-route texts from the notify phone are not read');
    }
}
const loop = new IncidentLoop({
    api,
    transport,
    zipOf: nominatimZip(osmAgent),
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
notices?.start(config.notifyTickMs);

app.addHook('onClose', async () => {
    loop.stop();
    notices?.stop();
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
