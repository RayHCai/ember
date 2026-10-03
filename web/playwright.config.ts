import { defineConfig, devices } from "@playwright/test";

// Tests run their own dev servers, so they never reuse `make dev` or `make app`:
// - 5174: mock event stream, no map keys (always the labeled fallback map).
// - 5176: live mode, pointed at a server the live test starts on 8011.
export const MOCK_PORT = 5174;
export const LIVE_PORT = 5176;
export const LIVE_SERVER_PORT = 8011;

const NO_MAP_KEYS = { VITE_GOOGLE_MAPS_API_KEY: "", VITE_CESIUM_ION_TOKEN: "" };

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${MOCK_PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: `npx vite --port ${MOCK_PORT}`,
      url: `http://localhost:${MOCK_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_USE_MOCK: "1", ...NO_MAP_KEYS },
    },
    {
      command: `npx vite --port ${LIVE_PORT}`,
      url: `http://localhost:${LIVE_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_USE_MOCK: "0",
        VITE_SERVER_URL: `http://127.0.0.1:${LIVE_SERVER_PORT}`,
        ...NO_MAP_KEYS,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // Software WebGL so Cesium renders in headless runs.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
  ],
});
