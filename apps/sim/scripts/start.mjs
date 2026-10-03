// Starts the sim with its launch settings: the desktop window, or a browser tab with --browser.
// The drone is chosen in the window; --drone skips that screen.
import { spawn } from 'node:child_process';
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

let command = ['tauri', 'dev'];
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
