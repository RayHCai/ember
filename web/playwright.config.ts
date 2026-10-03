import { defineConfig, devices } from "@playwright/test";

// Tests run their own dev server on 5174 with no map keys (always the labeled
// fallback map) and no logic service (the built-in dummy data).
export const PORT = 5174;

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
    env: { VITE_SERVER_URL: "", VITE_GOOGLE_MAPS_API_KEY: "", VITE_CESIUM_ION_TOKEN: "" },
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
