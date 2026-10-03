import { expect, test, type Page } from "@playwright/test";
import { collectErrors, openConsole, waitForTiles } from "./helpers";

async function stepTo(page: Page, label: string) {
  const controls = page.getByTestId("demo-controls");
  for (let i = 0; i < 8; i++) {
    if (await controls.getByText(label, { exact: true }).isVisible()) return;
    await controls.getByRole("button", { name: "Next step" }).click();
    await page.waitForTimeout(300);
  }
  await expect(controls.getByText(label, { exact: true })).toBeVisible();
}

test("the demo plays the whole story", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await openConsole(page);
  await waitForTiles(page);
  const controls = page.getByTestId("demo-controls");
  await expect(controls).toBeVisible();
  // Start over, paused on the first step, so each beat can be inspected.
  await controls.getByRole("button", { name: "Reset demo" }).click();
  await expect(controls.getByText("Zone ready", { exact: true })).toBeVisible();

  await stepTo(page, "Survey");
  await controls.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "../out/demo-1-survey.png" });
  await controls.getByRole("button", { name: "Pause" }).click();

  await stepTo(page, "Report");
  const report = page.getByTestId("report-panel");
  await expect(report).toBeVisible();
  await expect(report).toContainText("Template summary");
  await expect(report.locator("figure img")).toBeVisible({ timeout: 20_000 });
  await expect(report).toContainText("Simulated capture from 3D map");
  await expect(page.locator("main")).toHaveAttribute("data-filter", "thermal");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "../out/demo-2-report.png" });

  expect(errors).toEqual([]);
});
