import { expect, test } from "@playwright/test";
import { airborneDroneOnScreen, collectErrors, openConsole, resetDemo, waitForTiles } from "./helpers";

// Default Cesium widgets that must stay off.
const DEFAULT_WIDGETS = [
  ".cesium-viewer-animationContainer",
  ".cesium-viewer-timelineContainer",
  ".cesium-baseLayerPicker-selected",
  ".cesium-viewer-geocoderContainer",
  ".cesium-home-button",
  ".cesium-sceneModePicker-wrapper",
  ".cesium-navigationHelpButton-wrapper",
  ".cesium-viewer-fullscreenContainer",
  ".cesium-infoBox",
  ".cesium-selection-wrapper",
].join(", ");

test("opens on dummy data with no console errors", async ({ page }) => {
  const errors = collectErrors(page);
  await openConsole(page);

  await expect(page.locator(DEFAULT_WIDGETS)).toHaveCount(0);

  // HUD shell.
  await expect(page.getByText("EMBER", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Layers" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent" })).toBeVisible();
  await expect(page.getByText("Demo data", { exact: true })).toBeVisible();

  // No map keys in tests, so the labeled OpenStreetMap fallback must be active.
  const badge = page.getByTestId("map-badge");
  await expect(badge).toHaveAttribute("data-map", "osm");
  await expect(badge).toContainText("Fallback map");

  // Dummy data: the demo zone, its clock, and its last report, ready on launch.
  const simTime = page.getByTestId("sim-time");
  const first = await simTime.textContent();
  await expect(simTime).not.toHaveText(first ?? "", { timeout: 5000 });
  await expect(page.getByText(/Dummy data loaded/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open report" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run demo" })).toBeVisible();

  // Layer toggles are wired to the store.
  const drones = page.getByRole("checkbox", { name: /Drones/ });
  await expect(drones).toBeChecked();
  await page.getByText("Drones", { exact: true }).click();
  await expect(drones).not.toBeChecked();

  await waitForTiles(page);
  await page.screenshot({ path: "../out/smoke-console.png" });

  expect(errors).toEqual([]);
});

test("shows mock drones and opens the drone inspector", async ({ page }) => {
  const errors = collectErrors(page);
  await openConsole(page, { reducedMotion: true });
  await resetDemo(page);
  await waitForTiles(page);
  const controls = page.getByTestId("demo-controls");
  await controls.getByRole("button", { name: "Next step" }).click();
  await controls.getByRole("button", { name: "Play" }).click();
  // Drones move fast at 360x: pause with one in the air, then click it.
  let spot: { x: number; y: number } | null = null;
  for (let i = 0; i < 60 && !spot; i++) {
    await page.waitForTimeout(250);
    spot = await airborneDroneOnScreen(page);
  }
  expect(spot).not.toBeNull();
  await controls.getByRole("button", { name: "Pause" }).click();
  await page.waitForTimeout(600);
  spot = await airborneDroneOnScreen(page);
  expect(spot).not.toBeNull();
  await page.mouse.click(spot!.x, spot!.y);
  const inspector = page.getByTestId("drone-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("SIM");
  await expect(inspector).toContainText("Surveying");
  await page.screenshot({ path: "../out/mock-drones.png" });
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(inspector).toBeHidden();
  expect(errors).toEqual([]);
});

test("switches map filters with keys 1 to 4", async ({ page }) => {
  const errors = collectErrors(page);
  await openConsole(page, { reducedMotion: true });
  await resetDemo(page);
  await page.waitForTimeout(1500);
  await waitForTiles(page);

  const main = page.locator("main");
  for (const [key, id] of [["2", "thermal"], ["3", "night"], ["4", "crt"], ["1", "normal"]] as const) {
    await page.keyboard.press(key);
    await expect(main).toHaveAttribute("data-filter", id);
    await expect(page.getByRole("button", { pressed: true, name: new RegExp(id, "i") })).toBeVisible();
    // Software WebGL in headless runs can lag a frame behind; let it settle.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `../out/filter-${id}.png` });
  }

  expect(errors).toEqual([]);
});
