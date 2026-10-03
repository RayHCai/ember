import { config } from 'dotenv';

config();
import { defineConfig } from 'prisma/config';

// Read directly so `prisma generate` works in CI without a database URL.
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: { url: process.env.DATABASE_URL ?? '' },
});
