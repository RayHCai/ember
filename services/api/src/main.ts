import { config } from 'dotenv';
import { buildApp } from './app.js';
import { createPrisma } from './db.js';

config();

const port = Number(process.env.PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be 1-65535, got ${process.env.PORT}`);
}

const prisma = createPrisma();
const app = buildApp(prisma);
app.addHook('onClose', () => prisma.$disconnect());
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
