// Starts the sim with its launch settings: the desktop window, or a browser tab with --browser.
// The drone is chosen in the window; --drone skips that screen.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DEMO_DATA_URL } from '../src/launch.ts';

const DEV_URL = 'http://localhost:5180';

const say = (line = '') => process.stdout.write(`${line}\n`);

const { values: opts } = parseArgs({
    options: {
        drone: { type: 'string' },
        'drone-info': { type: 'string' },
        'demo-data': { type: 'string' },
        browser: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

if (opts.help) {
    say(
        'pnpm --filter @ember/drone-sim start [--drone ID] [--drone-info URL] [--demo-data URL] [--browser]',
    );
    say('  --drone       drone to show, skipping the connect screen');
    say('  --drone-info  Drone Info service (env EMBER_DRONE_INFO_URL); empty: dummy drones');
    say(
        `  --demo-data   Demo Data service (env EMBER_DEMO_DATA_URL); default ${DEFAULT_DEMO_DATA_URL}`,
    );
    say('  --browser     serve the sim for a browser tab instead of opening the desktop window');
    process.exit(0);
}

const drone = (opts.drone ?? '').trim();
const droneInfoUrl = (opts['drone-info'] ?? process.env.EMBER_DRONE_INFO_URL ?? '').trim();
const demoDataUrl = (opts['demo-data'] ?? process.env.EMBER_DEMO_DATA_URL ?? '').trim();
const env = {
    ...process.env,
    EMBER_DRONE: drone,
    EMBER_DRONE_INFO_URL: droneInfoUrl,
    EMBER_DEMO_DATA_URL: demoDataUrl,
};

/** CSP sources for a service on another host; the window's CSP already allows loopback. */
function remoteSources(raw, schemes) {
    if (!raw) return [];
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return [];
    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    return schemes.map((scheme) => `${scheme}${secure ? 's' : ''}://${u.host}`);
}

/** Tauri config args that widen the window's CSP to the remote services this launch names. */
function cspOverride() {
    const extra = [
        ...remoteSources(droneInfoUrl, ['http', 'ws']),
        ...remoteSources(demoDataUrl, ['http']),
    ];
    if (extra.length === 0) return [];
    const conf = JSON.parse(
        readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    );
    const csp = conf.app.security.csp
        .split(';')
        .map((d) => d.trim())
        .map((d) => (/^(connect|img)-src /.test(d) ? `${d} ${extra.join(' ')}` : d))
        .join('; ');
    // A file rather than inline JSON, which the Windows shell would strip the quotes from.
    const file = join(mkdtempSync(join(tmpdir(), 'ember-drone-sim-')), 'csp.json');
    writeFileSync(file, JSON.stringify({ app: { security: { csp } } }));
    return ['--config', file];
}

let command = opts.browser ? [] : ['tauri', 'dev', ...cspOverride()];
if (opts.browser) {
    const q = new URLSearchParams();
    if (drone) q.set('drone', drone);
    if (droneInfoUrl) q.set('droneInfo', droneInfoUrl);
    if (demoDataUrl) q.set('demoData', demoDataUrl);
    say(`Open ${DEV_URL}/${q.size ? `?${q}` : ''}`);
    command = ['vite'];
}
const child = spawn('pnpm', ['exec', ...command], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
