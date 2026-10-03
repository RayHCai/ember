import { expect, test, type Page } from "@playwright/test";
import { collectErrors, openConsole, waitForTiles } from "./helpers";

async function clickGlobe(page: Page, x: number, y: number) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
}

test("draw a zone and run it end to end on dummy data", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await openConsole(page, { reducedMotion: true });
  await page.waitForTimeout(2000);
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
  await expect(page.getByRole("button", { name: /Test ridge/ })).toBeVisible();
  await expect(page.getByTestId("dummy-map-note")).toContainText(/dummy/i);

  // Edge servers: suggest, add one by clicking, deploy.
  await page.getByRole("button", { name: "Suggest edge servers" }).click();
  const coverage = page.getByTestId("coverage-pct");
  await expect(coverage).toBeVisible();
  expect(parseFloat((await coverage.textContent()) ?? "0")).toBeGreaterThan(50);
  const count = page.locator("text=Servers").locator("xpath=following-sibling::span[1]");
  const before = Number(await count.textContent());
  await clickGlobe(page, 600, 360);
  await expect(count).toHaveText(String(before + 1));
  await page.getByRole("button", { name: "Deploy edge servers" }).click();
  await expect(page.getByText(/deployed\. Coverage/)).toBeVisible();
  await page.screenshot({ path: "../out/zone-deployed.png" });

  // Run survey: drones sweep the zone and a report comes back.
  await page.getByRole("button", { name: "Run survey" }).click();
  await expect(page.getByTestId("survey-progress")).toBeVisible();
  await expect(page.getByTestId("report-panel")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Back to agent" }).click();

  // Start test fire inside the new zone: verified, then confirmed with alerts.
  await page.getByRole("button", { name: /Start test fire/ }).click();
  await clickGlobe(page, 720, 470);
  const card = page.getByTestId("incident-card");
  await expect(card).toContainText("Possible fire");
  await expect(card).toContainText("Fire confirmed", { timeout: 60_000 });
  await expect(page.getByTestId("tier-counts")).toBeVisible();
  await page.screenshot({ path: "../out/zone-fire.png" });

  expect(errors).toEqual([]);
});
