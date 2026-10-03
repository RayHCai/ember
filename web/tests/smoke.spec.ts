import { expect, test } from "@playwright/test";

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

test("loads the globe with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");
  await expect(page.locator("main[data-globe-ready='true']")).toBeAttached();
  await expect(page.locator(".cesium-widget canvas")).toBeVisible();
  await expect(page.locator(DEFAULT_WIDGETS)).toHaveCount(0);

  // Give the globe a few frames to render before the screenshot.
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "../out/smoke-globe.png" });

  expect(errors).toEqual([]);
});
