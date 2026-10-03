import { defineConfig, devices } from "@playwright/test";

// Tests run their own dev server on 5174 with the mock event stream and no map
// keys, so they never reuse `make dev` and always exercise the fallback map.
const PORT = 5174;

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npx vite --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_USE_MOCK: "1",
      VITE_GOOGLE_MAPS_API_KEY: "",
      VITE_CESIUM_ION_TOKEN: "",
    },
  },
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
