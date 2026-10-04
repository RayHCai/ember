// `pnpm demo`: the whole stack, a third drone on this machine, the dashboard and drone-sim, with a
// small watch zone on the Lahaina fire that three drones map in about 30 s. Nothing flies until
// a scan is started. The dashboard comes up without waiting for drones; the script keeps polling
// for the edge-connector and drones and says when they connect or drop. Ctrl+C stops what this
// started; the compose stack keeps running.
//
//   pnpm demo              build images, then start
//   pnpm demo --no-build   reuse the images already built
//   pnpm demo:laptop       everything but the edge: no edge-connector, sim drones or local drone.
//                          The edge-connector runs on another machine (scripts/run-edge.sh) and a
//                          Pi drone pairs with it (scripts/setup-pi.sh); this prints both commands.
//     --drone ID           the drone drone-sim follows (default drone-pi)
//     --host-ip IP         this machine's LAN address, when the guess is wrong
//     --tailscale          the edge and Pi reach this machine over Tailscale, not the LAN
//
//   All three machines on one network (e.g. the phone hotspot): plain pnpm demo:laptop, no
//   Tailscale. This machine on another network (venue Wi-Fi) than the Mac Mini and Pi: add
//   --tailscale and put all three on the tailnet, since edge-manager dials the connector at :8070,
//   the connector dials edge-manager at :8060 and the Pi pulls frames from :8090, all across the
//   two networks.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = join(ROOT, '.demo');
const API = 'http://localhost:4001';
const DRONE_INFO = 'localhost:4002';
const DEMO_DATA = 'http://localhost:8090';
const DASHBOARD = 'http://localhost:5173';
const SIM = 'http://localhost:5180';

const OPERATOR = {
    email: 'operator@ember.test',
    name: 'Field Operator',
    password: 'ember-ops-2026',
};
const ZONE_NAME = 'Lahaina town';
// The densest burning patch near the town at 15:45 (about 70% of this circle alight, from Demo
// Data's arrival raster). Every drone takes off at the edge server, so mapping starts at takeoff;
// a 130 m radius leaves 100 m to fly once the geofence margin is taken.
const EDGE = { lat: 20.88333, lng: -156.66872 };
const RADIUS_M = 130;
const BOUNDARY = [
    { lat: EDGE.lat + 0.0012, lng: EDGE.lng - 0.0013 },
    { lat: EDGE.lat + 0.0012, lng: EDGE.lng + 0.0013 },
    { lat: EDGE.lat - 0.0012, lng: EDGE.lng + 0.0013 },
    { lat: EDGE.lat - 0.0012, lng: EDGE.lng - 0.0013 },
];
const CLOCK = { scenario_time: '2023-08-08T15:45:00-10:00', speed: 1, paused: false };
const FLEET_HOME = `${EDGE.lat},${EDGE.lng}`;
const DRONE_HOME = `${EDGE.lat + 0.0002},${EDGE.lng}`;
const REMOTE_EDGE = process.argv.includes('--remote-edge');
const TAILSCALE = process.argv.includes('--tailscale');
const DRONE = { id: flag('--drone') ?? (REMOTE_EDGE ? 'drone-pi' : 'real-1'), name: 'Field unit' };
// The services a remote edge replaces: it brings the connector, and the Pi is the drone.
const EDGE_SERVICES = ['edge-connector', 'drone-fleet'];

const children = [];
const isWindows = process.platform === 'win32';

function flag(name) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
}

function log(msg) {
    console.log(`[demo] ${msg}`);
}

function fail(msg) {
    console.error(`[demo] ${msg}`);
    stopChildren();
    process.exit(1);
}

function run(cmd, args, env = {}) {
    const r = spawnSync(cmd, args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: isWindows,
        env: { ...process.env, ...env },
    });
    if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
}

function capture(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: isWindows });
    if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
    return r.stdout;
}

// The key compose gives edge-manager: the shell's, else .env's, else compose's default.
function edgeKey() {
    if (process.env.EMBER_EDGE_KEY) return process.env.EMBER_EDGE_KEY;
    const env = join(ROOT, '.env');
    const line = existsSync(env) ? readFileSync(env, 'utf8').match(/^EMBER_EDGE_KEY=(.*)$/m) : null;
    return line?.[1].trim() || null;
}

const lanRank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);

// Docker, WSL and VPN adapters are not what the other machines can reach.
function lanAddress() {
    const virtual =
        /docker|vethernet|wsl|hyper-v|vmware|virtualbox|vboxnet|br-|veth|utun|awdl|llw|tailscale|zerotier/i;
    return Object.entries(networkInterfaces())
        .filter(([name]) => !virtual.test(name))
        .flatMap(([, addrs]) => addrs ?? [])
        .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        .map((a) => a.address)
        .toSorted((a, b) => lanRank(a) - lanRank(b))[0];
}

// Tailscale hands out addresses in the CGNAT range, 100.64.0.0/10.
function tailscaleAddress() {
    return Object.values(networkInterfaces())
        .flatMap((addrs) => addrs ?? [])
        .find((a) => {
            const [first, second] = a.address.split('.').map(Number);
            return a.family === 'IPv4' && first === 100 && second >= 64 && second < 128;
        })?.address;
}

function start(name, cmd, args, cwd = ROOT) {
    const out = createWriteStream(join(LOGS, `${name}.log`));
    const child = spawn(cmd, args, { cwd, shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('exit', (code) => {
        if (!stopping) log(`${name} exited (${code}); see .demo/${name}.log`);
    });
    children.push(child);
}

let stopping = false;
function stopChildren() {
    stopping = true;
    for (const child of children) {
        if (child.exitCode !== null) continue;
        // shell: true puts a cmd.exe between us and the process, so kill the whole tree.
        if (isWindows)
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGINT');
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, check, timeoutS = 180, until = Date.now() + timeoutS * 1000) {
    try {
        if (await check()) return;
    } catch {
        // not up yet
    }
    if (Date.now() > until) fail(`timed out waiting for ${what}`);
    await sleep(1000);
    return waitFor(what, check, timeoutS, until);
}

async function http(method, url, { token, body } = {}) {
    const init = { method, headers: token ? { authorization: `Bearer ${token}` } : {} };
    if (body) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null };
}

async function signIn() {
    const r = await http('POST', `${API}/v1/auth/sign-in`, { body: OPERATOR });
    if (r.ok) return r.json.token;
    const up = await http('POST', `${API}/v1/auth/sign-up`, { body: OPERATOR });
    if (!up.ok) fail(`could not sign in or sign up ${OPERATOR.email} (${up.status})`);
    return up.json.token;
}

async function ensureZone(token) {
    const zones = (await http('GET', `${API}/v1/watch-zones`, { token })).json;
    const existing = zones.find((z) => z.name === ZONE_NAME);
    if (existing) {
        if (JSON.stringify(existing.boundary) === JSON.stringify(BOUNDARY)) return existing;
        const r = await http('PATCH', `${API}/v1/watch-zones/${existing.id}`, {
            token,
            body: { boundary: BOUNDARY },
        });
        if (!r.ok) fail(`could not move the zone (${r.status})`);
        return r.json;
    }
    const r = await http('POST', `${API}/v1/watch-zones`, {
        token,
        body: { name: ZONE_NAME, region: 'Lahaina, Maui', boundary: BOUNDARY },
    });
    if (!r.ok) fail(`could not create the zone (${r.status})`);
    return r.json;
}

async function edgeServer(token) {
    const servers = (await http('GET', `${API}/v1/edge-servers`, { token })).json;
    return servers.find((s) => s.live?.online) ?? null;
}

async function assignEdge(token, zone, server) {
    const placed =
        server.zoneId === zone.id &&
        server.connectivityRadiusM === RADIUS_M &&
        Math.abs((server.location?.lat ?? 0) - EDGE.lat) < 1e-6 &&
        Math.abs((server.location?.lng ?? 0) - EDGE.lng) < 1e-6;
    if (placed) return;
    const p = await http('POST', `${API}/v1/watch-zones/${zone.id}/placements`, {
        token,
        body: { location: EDGE, connectivityRadiusM: RADIUS_M, name: 'Quick edge' },
    });
    if (!p.ok) fail(`could not plan the edge site (${p.status})`);
    const a = await http('POST', `${API}/v1/placements/${p.json.placementId}/assign`, {
        token,
        body: { edgeServerId: server.edgeServerId },
    });
    if (!a.ok) fail(`could not assign ${server.edgeServerId} to the zone (${a.status})`);
}

// The most recently seen drone in drone-info's fleet that is not a simulated one.
function pairedDrone() {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${DRONE_INFO}/v1/stream`);
        const done = (id) => {
            clearTimeout(timer);
            ws.close();
            resolve(id);
        };
        const timer = setTimeout(() => done(null), 3000);
        ws.addEventListener('error', () => done(null));
        ws.addEventListener('message', (e) => {
            const m = JSON.parse(String(e.data));
            if (m.type !== 'fleet') return;
            const real = m.drones
                .filter((d) => d.kind !== 'simulated' || !d.droneId.startsWith('sim-'))
                .toSorted((a, b) => b.lastSeen.localeCompare(a.lastSeen));
            done(real[0]?.droneId ?? null);
        });
    });
}

async function serving(url) {
    try {
        return (await fetch(url)).ok;
    } catch {
        return false;
    }
}

function open(url) {
    if (isWindows)
        spawn('cmd', ['/c', 'start', '""', url.replaceAll('&', '^&')], { stdio: 'ignore' });
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
}

async function main() {
    if (!existsSync(join(ROOT, 'data', 'derived', 'world'))) {
        fail('no ./data/derived/world: build the scenario first (uv run demo-data build)');
    }
    mkdirSync(LOGS, { recursive: true });

    const build = process.argv.includes('--no-build') ? [] : ['--build'];
    let hostIp = null;
    if (REMOTE_EDGE) {
        hostIp = flag('--host-ip') ?? (TAILSCALE ? tailscaleAddress() : lanAddress());
        if (!hostIp)
            fail(
                TAILSCALE
                    ? 'no Tailscale address on this machine: is Tailscale up?'
                    : "could not tell this machine's LAN address; pass --host-ip",
            );
        // A connector left from a one-machine demo would pair the sim drones and take the zone.
        log('stopping the local edge-connector and sim drones, if any');
        run('docker', ['compose', 'stop', ...EDGE_SERVICES]);
        const services = capture('docker', ['compose', 'config', '--services'])
            .split(/\s+/)
            .filter((s) => s && !EDGE_SERVICES.includes(s));
        log('starting the compose stack without the edge');
        run('docker', ['compose', 'up', '-d', ...build, ...services]);
    } else {
        log('starting the compose stack');
        run('docker', ['compose', 'up', '-d', ...build], { EMBER_FLEET_HOME: FLEET_HOME });
    }
    run('pnpm', ['--filter', '@ember/contracts', 'build']);

    await waitFor('the api', async () => (await fetch(`${API}/healthz`)).ok);
    await waitFor('demo-data', async () => (await fetch(`${DEMO_DATA}/health`)).ok, 300);
    // A fresh Demo Data takes ~30 s over its first frame, past the drones' 15 s camera timeout: they
    // reconnect and pile renders on until none arrive in time. One frame here warms it up.
    log('warming up Demo Data');
    const frame = `${DEMO_DATA}/v1/observation?lat=${EDGE.lat}&lon=${EDGE.lng}&alt_m=60&t=${encodeURIComponent(CLOCK.scenario_time)}`;
    await waitFor('a first Demo Data frame', async () => (await fetch(frame)).ok, 120);
    // Set now so drones and viewers that connect while pairing already see the fire; set again
    // once ready so the scan starts at the same moment every time.
    const early = await http('PUT', `${DEMO_DATA}/v1/clock`, { body: CLOCK });
    if (!early.ok) fail(`could not set Demo Data's clock (${early.status})`);

    if (!(await serving(DASHBOARD)))
        start('dashboard', 'pnpm', ['--filter', '@ember/dashboard', 'dev']);
    if (!(await serving(SIM))) start('drone-sim', 'pnpm', ['--filter', '@ember/drone-sim', 'dev']);

    const token = await signIn();
    if (REMOTE_EDGE) {
        const key = edgeKey();
        console.log(`
  This machine is ${hostIp}${TAILSCALE ? ' on Tailscale' : ''}. Allow inbound TCP 8060 and 8090 through its firewall, then:

  Mac Mini (edge-connector), from its ember checkout${TAILSCALE ? ', with Tailscale up' : ''}:
    ${key ? `EMBER_EDGE_KEY=${key} ` : ''}bash scripts/run-edge.sh --manager ${hostIp}

  Raspberry Pi (drone-runtime; finds the Mac Mini over mDNS${TAILSCALE ? ' on their shared network' : ''}):${
      TAILSCALE
          ? `
    curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up   # once, for Demo Data`
          : ''
  }
    bash scripts/setup-pi.sh --id ${DRONE.id} --home ${DRONE_HOME} --sensor-url ws://${hostIp}:8090/v1/stream
  Already set up? Re-running it updates the config and restarts the drone.
`);
    }

    const zone = await ensureZone(token);
    await waitFor('the dashboard', async () => (await fetch(DASHBOARD)).ok, 120);
    await waitFor('drone-sim', async () => (await fetch(SIM)).ok, 120);

    const dashboardUrl = `${DASHBOARD}/#/zones/${zone.id}`;
    open(dashboardUrl);

    log('ready');
    console.log(`
  Dashboard  ${dashboardUrl}
             sign in as ${OPERATOR.email} / ${OPERATOR.password}
  Logs       .demo/

  Searching for ${REMOTE_EDGE ? 'the edge-connector and its drone' : 'the edge-connector and three drones'} every ${WATCH_MS / 1000} s;
  drone-sim opens once they are connected.
  Ctrl+C stops the dev servers${REMOTE_EDGE ? '' : ` and ${DRONE.id}`}; "docker compose down" stops the rest.
`);

    await watchFleet(token, zone);
}

const WATCH_MS = 5000;

// Polls until Ctrl+C, so the demo is usable before the drones are: assigns the edge-connector to
// the zone when one comes online, says when drones connect or drop, and opens drone-sim (with the
// clock reset to the scenario start) once the fleet is complete.
async function watchFleet(token, zone, fleet = { edgeId: null, drones: 0, ready: false }) {
    try {
        await checkFleet(token, zone, fleet);
    } catch (err) {
        log(`fleet check failed: ${err.message ?? err}; retrying`);
    }
    await sleep(WATCH_MS);
    return watchFleet(token, zone, fleet);
}

async function checkFleet(token, zone, fleet) {
    const want = REMOTE_EDGE ? 1 : 3;
    const server = await edgeServer(token);
    if (!server) {
        if (fleet.edgeId) log(`${fleet.edgeId} went offline; searching for an edge-connector`);
        Object.assign(fleet, { edgeId: null, drones: 0, ready: false });
        return;
    }
    if (server.edgeServerId !== fleet.edgeId) {
        fleet.edgeId = server.edgeServerId;
        log(`\x07edge-connector ${fleet.edgeId} connected`);
        await assignEdge(token, zone, server);
        if (server.live.run && server.live.run.state !== 'done')
            log(
                `${fleet.edgeId} is flying run ${server.live.run.runId}; let it land before a scan`,
            );
    }
    const n = server.live.connectedDrones;
    if (n > fleet.drones) log(`\x07drone connected (${n}/${want})`);
    else if (n < fleet.drones) log(`drone disconnected (${n}/${want}); searching`);
    fleet.drones = n;

    // A third drone already paired (a Pi, or one left from an earlier run) stands in for this one.
    if (!REMOTE_EDGE && !fleet.localStarted && n === 2) {
        fleet.localStarted = true;
        log(`flying ${DRONE.id} from this machine`);
        startLocalDrone();
    }

    if (n < want) fleet.ready = false;
    else if (!fleet.ready) fleet.ready = await fleetReady(server, fleet.simOpened);
    if (fleet.ready) fleet.simOpened = true;
}

// The fleet just reached full strength: settle which drone to follow, restart the scenario clock
// so every scan starts at the same moment, and open drone-sim the first time.
async function fleetReady(server, simOpened) {
    // The Pi keeps whatever id it was set up with; follow that one unless --drone says otherwise.
    if (REMOTE_EDGE && !flag('--drone')) {
        const found = await pairedDrone();
        if (!found) return false; // not on drone-info yet; next poll
        if (found !== DRONE.id) log(`following ${found}, the drone that paired`);
        DRONE.id = found;
    }
    if (server.live.run && server.live.run.state !== 'done') {
        log('a run is in flight; leaving the scenario clock alone');
    } else {
        const clock = await http('PUT', `${DEMO_DATA}/v1/clock`, { body: CLOCK });
        if (!clock.ok) log(`could not reset Demo Data's clock (${clock.status})`);
    }
    const simUrl = `${SIM}/?drone=${DRONE.id}&droneInfo=${DRONE_INFO}`;
    if (!simOpened) open(simUrl);
    log(`\x07all drones connected: start a scan from the dashboard`);
    console.log(`  drone-sim  ${simUrl}\n`);
    return true;
}

function startLocalDrone() {
    start(DRONE.id, 'uv', [
        'run',
        '--package',
        'ember-drone-runtime',
        'drone-runtime',
        'run',
        '--id',
        DRONE.id,
        '--name',
        isWindows ? `"${DRONE.name}"` : DRONE.name,
        '--edge',
        'ws://127.0.0.1:8070/v1/drone',
        '--home',
        DRONE_HOME,
        '--camera',
        'sensor-stream',
        '--sensor-url',
        'ws://127.0.0.1:8090/v1/stream',
    ]);
}

process.on('SIGINT', () => {
    log('stopping');
    stopChildren();
    process.exit(0);
});

main().catch((err) => fail(err.stack ?? String(err)));
