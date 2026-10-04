import { defineConfig } from 'vitest/config';

// Unit tests only; tests/ holds the Playwright browser tests.
export default defineConfig({
    define: { __EMBER_LIVE__: 'false' },
    test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
