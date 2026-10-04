import { defineConfig, devices } from '@playwright/test';

// Tests run their own dev server on 5174 with no map keys (always the labeled fallback map).
export const PORT = 5174;

export default defineConfig({
    testDir: 'tests',
    timeout: 90_000,
    workers: 1,
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1440, height: 900 },
    },
    webServer: {
        command: `pnpm exec vite --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: false,
        timeout: 60_000,
        // Live mode off: the browser tests run on the dummy data alone.
        env: { VITE_GOOGLE_MAPS_API_KEY: '', VITE_CESIUM_ION_TOKEN: '', EMBER_LIVE: '0' },
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 900 },
                // PW_CHANNEL=chrome runs on an installed Chrome instead of Playwright's download.
                channel: process.env.PW_CHANNEL || undefined,
                // Software WebGL so Cesium renders in headless runs.
                launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
            },
        },
    ],
});
