import { config } from 'dotenv';

config();
import { buildApp } from './app.js';
import { createPrisma } from './db.js';

const port = Number(process.env.PORT ?? 4001);
const prisma = createPrisma();
const app = buildApp(prisma);
app.addHook('onClose', () => prisma.$disconnect());
await app.listen({ port, host: '0.0.0.0' });
