import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./sync-assets.mjs');
process.env.API_URL ??= 'http://127.0.0.1:4001';
const { POST } = await import('./api/subscribe.ts');

const PUBLIC = fileURLToPath(new URL('public', import.meta.url));
const PORT = Number(process.env.PORT ?? 4010);
// compose sets HOST=0.0.0.0 so the port is reachable from outside the container.
const HOST = process.env.HOST ?? '127.0.0.1';
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};

// Stands in for Vercel locally: public/ as static files, api/subscribe.ts as the function.
createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/subscribe') {
        if (req.method !== 'POST') return res.writeHead(405).end();
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await POST(
            new Request(url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        return res.end(await response.text());
    }

    const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    try {
        const body = await readFile(join(PUBLIC, path));
        res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end('Not found');
    }
}).listen(PORT, HOST, () => {
    process.stdout.write(`contact-collector on http://${HOST}:${PORT}
`);
});
