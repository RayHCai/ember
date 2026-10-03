// Blocks staged files that look like they carry a live credential; CI runs gitleaks for the full history.

import { readFileSync, existsSync } from 'node:fs';

const patterns = [
    /sk-ant-[A-Za-z0-9_-]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /gh[pousr]_[A-Za-z0-9]{36}/,
];

const offenders = [];
for (const path of process.argv.slice(2)) {
    if (!existsSync(path) || path.endsWith('.env.example')) continue;
    if (/(^|\/)\.env(\.|$)/.test(path)) {
        offenders.push(`${path}: .env files are never committed`);
        continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const p of patterns) if (p.test(text)) offenders.push(`${path}: matches ${p}`);
}

if (offenders.length > 0) {
    console.error(`Possible secrets staged:\n  ${offenders.join('\n  ')}`);
    process.exit(1);
}
