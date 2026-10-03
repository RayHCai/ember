import { expect, test } from "@playwright/test";
import { collectErrors } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("a resident registers a town and receives the demo alert", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto("/alert?demo=1");
  await expect(page.getByText("Resident alerts")).toBeVisible();
  await expect(page.getByText("Demo alerts", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../out/resident-1-register.png" });

  await page.getByLabel("Or choose your town").selectOption({ label: "Sierra Madre" });
  await expect(page.getByTestId("resident-home")).toContainText("Sierra Madre");
  await expect(page.getByTestId("resident-clear")).toBeVisible();
  await page.getByRole("button", { name: "Tap to enable sound" }).click();
  await expect(page.getByText("Sound is on")).toBeVisible();

  // The demo story reaches the confirmed fire and its alerts.
  const alert = page.getByTestId("resident-alert");
  await expect(alert).toBeVisible({ timeout: 90_000 });
  await expect(alert).toContainText("Demo alert.");
  await page.screenshot({ path: "../out/resident-2-alert.png" });
  expect(errors).toEqual([]);
});
