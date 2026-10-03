import { expect, test } from "@playwright/test";
import { collectErrors, openConsole, resetDemo } from "./helpers";

test("the full demo runs three times in a row with resets between", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openConsole(page, { reducedMotion: true });
  const controls = page.getByTestId("demo-controls");
  for (let run = 1; run <= 3; run++) {
    await resetDemo(page);
    await expect(page.getByTestId("incident-card")).toBeHidden();
    for (let step = 0; step < 6; step++) {
      await controls.getByRole("button", { name: "Next step" }).click();
      await page.waitForTimeout(600);
    }
    await expect(controls.getByText("Contained", { exact: true })).toBeVisible();
    await expect(page.getByTestId("incident-card")).toContainText("Contained");
    await expect(page.getByTestId("tier-counts")).toBeVisible();
  }
  await page.screenshot({ path: "../out/qa-demo-done.png" });
  expect(errors).toEqual([]);
});

test("? shows the keyboard shortcuts", async ({ page }) => {
  await openConsole(page, { reducedMotion: true });
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Map filter");
  await page.screenshot({ path: "../out/qa-shortcuts.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
