import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_PORT } from "../playwright.config";
import { collectErrors, waitForTiles } from "./helpers";
import { TestServer } from "./server";

test.use({ baseURL: `http://localhost:${LIVE_PORT}` });

async function clickGlobe(page: Page, x: number, y: number) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
}

test("draw a zone, suggest edge servers, edit them, and deploy", async ({ page }) => {
  const errors = collectErrors(page);
  const server = new TestServer({
    EMBER_OSM_OFFLINE: "1",
    EMBER_DATA_DIR: mkdtempSync(join(tmpdir(), "ember-test-")),
  });
  await server.start();
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No watch zone yet").first()).toBeVisible();
    await page.waitForTimeout(2000); // opening flight (instant with reduced motion) and first tiles
    await waitForTiles(page);

    // Draw a square in the middle of the view and close it on the first point.
    await page.getByRole("button", { name: "New zone" }).click();
    const corners: [number, number][] = [
      [560, 330],
      [880, 330],
      [880, 600],
      [560, 600],
    ];
    for (const [x, y] of corners) await clickGlobe(page, x, y);
    await expect(page.getByTestId("draft-area")).not.toHaveText("--");
    await clickGlobe(page, corners[0]![0], corners[0]![1]);

    await page.getByLabel("Zone name").fill("Test ridge");
    await page.getByRole("button", { name: "Save zone" }).click();
    await expect(page.getByRole("button", { name: /Test ridge/ })).toBeVisible({ timeout: 20_000 });
    // Offline mode: the synthetic road grid is labeled, never passed off as real.
    await expect(page.getByTestId("osm-fallback")).toBeVisible();

    await page.getByRole("button", { name: "Suggest edge servers" }).click();
    const coverage = page.getByTestId("coverage-pct");
    await expect(coverage).toBeVisible({ timeout: 15_000 });
    const suggested = parseFloat((await coverage.textContent()) ?? "0");
    expect(suggested).toBeGreaterThanOrEqual(90);

    // Click the map to add a server: the count goes up by one.
    const count = page.locator("text=Servers").locator("xpath=following-sibling::span[1]");
    const before = Number(await count.textContent());
    await clickGlobe(page, 600, 360);
    await expect(count).toHaveText(String(before + 1));

    await page.getByRole("button", { name: "Deploy edge servers" }).click();
    await expect(page.getByText(/deployed\. Coverage/)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "../out/zone-deployed.png" });

    // WebSocket reconnect noise is not expected here; nothing else should log errors.
    expect(errors).toEqual([]);
  } finally {
    await server.stop();
  }
});
