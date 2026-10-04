#!/usr/bin/env node
// Runs Ember as an ASI:One agent on one machine: Postgres, Redis, api, planner, operator-agent and
// the uAgent bridge, supervised so a crashed service is restarted. See docs/asi1-agent.md.
//
//   node scripts/asi1/ember.mjs setup            install, build, secrets, database, migrations
//   node scripts/asi1/ember.mjs start            run everything in the foreground, supervised
//   node scripts/asi1/ember.mjs status           health of every service
//   node scripts/asi1/ember.mjs connect-mailbox  register the uAgent's Agentverse mailbox
//   node scripts/asi1/ember.mjs install-launchd  start at login and keep running (macOS)
//   node scripts/asi1/ember.mjs restart          graceful restart under launchd (after a pull and setup)
//   node scripts/asi1/ember.mjs stop             stop a launchd-run or foreground supervisor
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
    chmodSync,
    createWriteStream,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOME = process.env.EMBER_HOME ?? join(homedir(), '.ember');
const SECRETS = join(HOME, 'secrets.env');
const LOGS = join(HOME, 'logs');
const PID_FILE = join(HOME, 'supervisor.pid');
const LABEL = 'ai.ember.asi1';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const PG_PORT = 5433;
const MAX_LOG_BYTES = 50 * 1024 * 1024;

const USER_KEYS = [
    ['ANTHROPIC_API_KEY', 'Claude: every language call (optional; rules router without it)'],
    ['GEMINI_API_KEY', 'Gemini: alert map images only (optional)'],
    ['PHOTON_PROJECT_ID', 'Photon Spectrum iMessage (optional; texts are logged without it)'],
    ['PHOTON_PROJECT_SECRET', ''],
    ['AGENTVERSE_API_KEY', 'Agentverse API key, used once by connect-mailbox (starts with eyJ)'],
    [
        'DATABASE_URL',
        'Postgres for the api and agent; empty runs an embedded Postgres in EMBER_HOME',
    ],
    [
        'EMBER_OPERATOR_ASI1_ADDRESSES',
        'ASI:One sender addresses that are operators, comma-separated',
    ],
];
const GENERATED = {
    EMBER_UAGENT_SEED: () => `ember-${randomBytes(32).toString('hex')}`,
    EMBER_AGENT_KEY: () => randomBytes(24).toString('hex'),
    EMBER_OPERATOR_KEY: () => randomBytes(24).toString('hex'),
    EMBER_PLANNER_KEY: () => randomBytes(24).toString('hex'),
    EMBER_INGEST_KEY: () => randomBytes(24).toString('hex'),
    EMBER_PG_PASSWORD: () => randomBytes(18).toString('hex'),
};
const DEFAULTS = {
    EMBER_UAGENT_PORT: '8001',
    // Demo mode: every ASI:One user may act; approvals stay operator-only once alerts reach phones.
    EMBER_ASI1_OPEN_OPERATOR: 'true',
    EMBER_CLAUDE_MODEL: 'claude-haiku-4-5',
    EMBER_GEMINI_IMAGE_MODEL: 'gemini-2.5-flash-image',
};

function readEnv(path) {
    const env = {};
    if (!existsSync(path)) return env;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) env[m[1]] = m[2];
    }
    return env;
}

function log(msg) {
    console.log(`${new Date().toISOString()} ember: ${msg}`);
}

function setup() {
    mkdirSync(LOGS, { recursive: true });
    chmodSync(HOME, 0o700);
    const env = readEnv(SECRETS);
    const lines = existsSync(SECRETS)
        ? [readFileSync(SECRETS, 'utf8').trimEnd()]
        : ['# Ember secrets. Never commit this file.'];
    for (const [key, help] of USER_KEYS) {
        if (!(key in env)) lines.push(...(help ? [`# ${help}`] : []), `${key}=`);
    }
    for (const [key, make] of Object.entries(GENERATED)) {
        if (!env[key]) lines.push(`${key}=${make()}`);
    }
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!(key in env)) lines.push(`${key}=${value}`);
    }
    writeFileSync(SECRETS, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(SECRETS, 0o600);
    log(`secrets: ${SECRETS} (fill in the empty keys you have)`);

    const run = (cmd, args, cwd = REPO) => {
        log(`$ ${cmd} ${args.join(' ')}`);
        execFileSync(cmd, args, { cwd, stdio: 'inherit', env: childEnv({}) });
    };
    run('pnpm', ['install', '--frozen-lockfile']);
    run('uv', ['sync', '--all-packages']);
    run('pnpm', [
        '--filter',
        '@ember/contracts',
        '--filter',
        '@ember/api',
        '--filter',
        '@ember/operator-agent',
        'run',
        'build',
    ]);
    if (
        !readEnv(SECRETS).DATABASE_URL &&
        !existsSync(join(HOME, 'node_modules', 'embedded-postgres'))
    ) {
        run('npm', ['install', '--no-save', '--prefix', HOME, 'embedded-postgres@18.4.0-beta.17']);
    }
    log('setup done. Next: node scripts/asi1/ember.mjs start (or install-launchd)');
}

// launchd's PATH may lack this node (version managers use per-shell paths), and pnpm needs it.
const NODE_BIN = dirname(process.execPath);

function childEnv(extra) {
    const env = { ...process.env, ...extra, PATH: `${NODE_BIN}:${process.env.PATH ?? ''}` };
    // A shell's activated virtualenv would otherwise shadow the workspace's .venv for uv.
    delete env.VIRTUAL_ENV;
    return env;
}

function config() {
    if (!existsSync(SECRETS)) throw new Error(`no ${SECRETS}: run setup first`);
    const env = { ...DEFAULTS, ...readEnv(SECRETS) };
    const embedded = !env.DATABASE_URL;
    const db =
        env.DATABASE_URL ||
        `postgresql://ember:${env.EMBER_PG_PASSWORD}@localhost:${PG_PORT}/ember`;
    const api = 'http://localhost:4001';
    const shared = {
        ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
        EMBER_API_URL: api,
        EMBER_OPERATOR_AGENT_URL: 'http://localhost:4006',
        EMBER_REDIS_URL: 'redis://localhost:6379/0',
        NODE_ENV: 'production',
    };
    delete shared.DATABASE_URL;
    return { env, embedded, db, api, shared };
}

async function healthy(url, timeoutMs = 3000) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return res.status < 500 || res.status === 503;
    } catch {
        return false;
    }
}

async function waitFor(url, seconds) {
    for (let i = 0; i < seconds; i++) {
        if (await healthy(url)) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

function rotate(path) {
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
}

class Service {
    constructor(name, { cmd, args, cwd = REPO, env = {}, health }) {
        Object.assign(this, {
            name,
            cmd,
            args,
            cwd,
            env,
            health,
            child: null,
            failures: 0,
            restarts: 0,
            stopping: false,
        });
    }

    start() {
        const path = join(LOGS, `${this.name}.log`);
        rotate(path);
        const out = createWriteStream(path, { flags: 'a' });
        this.child = spawn(this.cmd, this.args, {
            cwd: this.cwd,
            env: childEnv(this.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.child.stdout.pipe(out);
        this.child.stderr.pipe(out);
        this.child.on('exit', (code, signal) => {
            this.child = null;
            if (!this.stopping) log(`${this.name} exited (${signal ?? code})`);
        });
        log(`${this.name} started (pid ${this.child.pid})`);
    }

    stop() {
        this.stopping = true;
        this.child?.kill('SIGTERM');
    }

    /** Dead, or failing health three checks in a row: restart, backing off up to a minute. */
    async check() {
        const alive = this.child !== null;
        const ok = alive && (!this.health || (await healthy(this.health)));
        this.failures = ok ? 0 : this.failures + 1;
        if (ok || (alive && this.failures < 3)) return;
        this.restarts += 1;
        const wait = Math.min(60, 2 ** Math.min(this.restarts, 6));
        log(`${this.name} unhealthy; restarting in ${wait}s (restart ${this.restarts})`);
        this.child?.kill('SIGKILL');
        this.child = null;
        this.failures = 0;
        await new Promise((r) => setTimeout(r, wait * 1000));
        if (!this.stopping) this.start();
    }
}

const uv = (pkg, ...rest) => ({
    cmd: 'uv',
    args: ['run', '--no-sync', '--package', pkg, pkg, ...rest],
});

async function startPostgres(cfg) {
    if (!cfg.embedded) return null;
    const require = createRequire(join(HOME, 'package.json'));
    const { default: EmbeddedPostgres } = await import(require.resolve('embedded-postgres'));
    const dataDir = join(HOME, 'pg');
    const pg = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: 'ember',
        password: cfg.env.EMBER_PG_PASSWORD,
        port: PG_PORT,
        persistent: true,
        onLog: () => {},
        onError: () => {},
    });
    const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
    if (fresh) await pg.initialise();
    await pg.start();
    if (fresh) await pg.createDatabase('ember');
    log(`postgres up on ${PG_PORT} (${dataDir})`);
    return pg;
}

async function start() {
    mkdirSync(LOGS, { recursive: true });
    const cfg = config();
    writeFileSync(PID_FILE, String(process.pid));
    const pg = await startPostgres(cfg);
    log('applying api migrations');
    execFileSync('pnpm', ['--filter', '@ember/api', 'run', 'db:deploy'], {
        cwd: REPO,
        env: childEnv({ DATABASE_URL: cfg.db }),
        stdio: 'ignore',
    });
    const services = [];
    try {
        execFileSync('redis-cli', ['ping'], { stdio: 'ignore' });
        log('using the redis already on 6379');
    } catch {
        services.push(
            new Service('redis', {
                cmd: 'redis-server',
                args: ['--port', '6379', '--dir', HOME, '--save', ''],
            }),
        );
    }
    services.push(
        new Service('api', {
            cmd: process.execPath,
            args: ['dist/main.js'],
            cwd: join(REPO, 'services/api'),
            env: { ...cfg.shared, PORT: '4001', DATABASE_URL: cfg.db, EMBER_API_STORE: 'prisma' },
            health: `${cfg.api}/healthz`,
        }),
        new Service('planner-worker', {
            ...uv('ember-planner', 'worker'),
            env: cfg.shared,
            health: 'http://localhost:4008/healthz',
        }),
        new Service('planner-orchestrator', {
            ...uv('ember-planner', 'orchestrator'),
            env: cfg.shared,
            health: 'http://localhost:4007/healthz',
        }),
        new Service('operator-agent', {
            cmd: process.execPath,
            args: ['dist/main.js'],
            cwd: join(REPO, 'services/operator-agent'),
            env: {
                ...cfg.shared,
                PORT: '4006',
                OPERATOR_AGENT_DATABASE_URL: cfg.db,
                EMBER_OPERATOR_RELAY_KEY: cfg.env.EMBER_OPERATOR_KEY,
            },
            health: 'http://localhost:4006/healthz',
        }),
        new Service('operator-uagent', {
            ...uv('ember-operator-uagent'),
            env: cfg.shared,
            health: 'http://localhost:4009/healthz',
        }),
    );
    for (const s of services) {
        s.start();
        if (s.name === 'api') {
            if (!(await waitFor(`${cfg.api}/healthz`, 60))) log('api is not answering yet');
            try {
                execFileSync(
                    'uv',
                    [
                        'run',
                        '--no-sync',
                        '--package',
                        'ember-seed-data',
                        'ember-seed-data',
                        'lahaina',
                        '--api',
                        cfg.api,
                        '--key',
                        cfg.env.EMBER_OPERATOR_KEY,
                    ],
                    { cwd: REPO, env: childEnv({}), stdio: 'ignore' },
                );
                log('lahaina seed loaded');
            } catch {
                log('seed failed; see the seed-data README');
            }
        }
    }

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        log('stopping');
        for (const s of services.toReversed()) s.stop();
        await new Promise((r) => setTimeout(r, 3000));
        await pg?.stop();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    log('all services started; supervising');
    for (;;) {
        await new Promise((r) => setTimeout(r, 15_000));
        if (stopping) return;
        for (const s of services) await s.check();
    }
}

async function status() {
    const cfg = existsSync(SECRETS) ? config() : null;
    const checks = [
        ['api', 'http://localhost:4001/healthz'],
        ['planner-orchestrator', 'http://localhost:4007/healthz'],
        ['planner-worker', 'http://localhost:4008/healthz'],
        ['operator-agent', 'http://localhost:4006/healthz'],
        ['operator-uagent', 'http://localhost:4009/healthz'],
    ];
    let allOk = true;
    for (const [name, url] of checks) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            const body = await res.text();
            allOk &&= res.ok;
            console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(21)} ${body.slice(0, 400)}`);
        } catch (err) {
            allOk = false;
            console.log(`DOWN ${name.padEnd(21)} ${err.cause?.code ?? err.message}`);
        }
    }
    const uagentLog = join(LOGS, 'operator-uagent.log');
    if (existsSync(uagentLog)) {
        const text = readFileSync(uagentLog, 'utf8');
        // The bridge warns once per start when Agentverse has no mailbox for it; silence means it has one.
        const mailbox = text.includes('mailbox not found')
            ? 'NOT connected: run connect-mailbox'
            : text.includes('Starting mailbox client')
              ? 'connected'
              : 'starting';
        console.log(`     agentverse mailbox      ${mailbox}`);
    }
    if (cfg)
        console.log(
            `     store                   ${cfg.embedded ? `embedded postgres in ${join(HOME, 'pg')}` : 'DATABASE_URL'}`,
        );
    process.exitCode = allOk ? 0 : 1;
}

async function connectMailbox() {
    const cfg = config();
    const key = cfg.env.AGENTVERSE_API_KEY;
    if (!key)
        throw new Error(`set AGENTVERSE_API_KEY in ${SECRETS} (Agentverse → profile → API Keys)`);
    const port = cfg.env.EMBER_UAGENT_PORT;
    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_token: key, agent_type: 'mailbox' }),
    });
    const body = await res.json();
    console.log(
        body.success
            ? 'mailbox connected: Ember is reachable from ASI:One'
            : `mailbox not connected: ${body.detail}`,
    );
    const health = await fetch('http://localhost:4009/healthz')
        .then((r) => r.json())
        .catch(() => null);
    if (health?.address) console.log(`agent address: ${health.address}`);
}

function installLaunchd() {
    const node = process.execPath;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${join(REPO, 'scripts/asi1/ember.mjs')}</string><string>start</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${NODE_BIN}:${process.env.PATH}</string>
    <key>EMBER_HOME</key><string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>${join(LOGS, 'supervisor.log')}</string>
  <key>StandardErrorPath</key><string>${join(LOGS, 'supervisor.log')}</string>
</dict></plist>
`;
    mkdirSync(dirname(PLIST), { recursive: true });
    mkdirSync(LOGS, { recursive: true });
    writeFileSync(PLIST, plist);
    const uid = String(process.getuid());
    try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
    } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { stdio: 'inherit' });
    log(`installed ${PLIST}: Ember starts at login and restarts if it stops. Logs: ${LOGS}`);
}

function stop() {
    const uid = String(process.getuid());
    if (existsSync(PLIST)) {
        try {
            execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
            log('launchd job stopped (runs again at next login; remove the plist to disable)');
            return;
        } catch {}
    }
    if (existsSync(PID_FILE)) {
        const pid = Number(readFileSync(PID_FILE, 'utf8'));
        try {
            process.kill(pid, 'SIGTERM');
            log(`supervisor ${pid} stopped`);
        } catch {
            log('supervisor was not running');
        }
    }
}

/** Under launchd: a graceful stop (launchd waits for the supervisor to exit), then a fresh start. */
async function restart() {
    const pid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8')) : 0;
    stop();
    for (let i = 0; i < 40; i++) {
        if (!pid) break;
        try {
            process.kill(pid, 0);
        } catch {
            break;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    installLaunchd();
}

const commands = {
    setup,
    start,
    status,
    'connect-mailbox': connectMailbox,
    'install-launchd': installLaunchd,
    restart,
    stop,
};
const command = commands[process.argv[2] ?? ''];
if (!command) {
    console.log(`usage: node scripts/asi1/ember.mjs <${Object.keys(commands).join('|')}>`);
    process.exitCode = 2;
} else {
    Promise.resolve(command()).catch((err) => {
        mkdirSync(LOGS, { recursive: true });
        appendFileSync(
            join(LOGS, 'supervisor.log'),
            `${new Date().toISOString()} ${err.stack ?? err}\n`,
            { flag: 'a' },
        );
        console.error(`ember: ${err.message}`);
        process.exitCode = 1;
    });
}
