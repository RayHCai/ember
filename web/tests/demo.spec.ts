import { expect, test, type Page } from "@playwright/test";
import { clickMap, collectErrors, openConsole, resetDemo, waitForTiles } from "./helpers";

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
  const controls = page.getByTestId("demo-controls");
  // Start over, paused on the first step, so each beat can be inspected.
  await resetDemo(page);
  await waitForTiles(page);

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

  // Hotspot: an unconfirmed fire, and an alert held for the operator.
  await stepTo(page, "Hotspot found");
  const card = page.getByTestId("incident-card");
  await expect(card).toContainText("Possible fire");
  await page.getByRole("button", { name: "Back to agent" }).click();
  await page.getByRole("tab", { name: /Approvals/ }).click();
  const approval = page.getByTestId("approval-card");
  await expect(approval).toContainText("not yet confirmed by a drone");
  await page.screenshot({ path: "../out/demo-3-hotspot.png" });
  await approval.getByRole("button", { name: "Approve alerts" }).click();
  await expect(page.getByTestId("sent-alerts")).toContainText("Approved by the operator");

  // Confirmed: alerts by tier, routes, the agent's runs, and a phone preview.
  await stepTo(page, "Fire confirmed");
  await expect(card).toContainText("Fire confirmed");
  await expect(page.getByTestId("tier-counts")).toBeVisible();
  await expect(page.getByTestId("sent-alerts")).toContainText("Evacuate");
  await page.getByRole("tab", { name: "Log" }).click();
  await expect(page.getByTestId("agent-run").first()).toBeVisible();
  await card.getByRole("button", { name: "Fly to fire" }).click();
  await page.waitForTimeout(3000);
  await card.getByRole("button", { name: "Phone preview" }).click();
  // Homes on the north edge of Sierra Madre, below the fire.
  await clickMap(page, 34.172, -118.053);
  await expect(page.getByTestId("phone-message")).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "../out/demo-4-confirmed.png" });
  await card.getByRole("button", { name: "Close phone preview" }).click();

  // Suppression: simulated, says so, and containment rises.
  await stepTo(page, "Suppression");
  await expect(page.getByTestId("suppression-banner")).toBeVisible();
  await page.getByTestId("demo-controls").getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("containment")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "../out/demo-5-suppression.png" });
  await page.getByTestId("demo-controls").getByRole("button", { name: "Pause" }).click();

  await stepTo(page, "Contained");
  await expect(card).toContainText("Contained");
  await expect(page.getByTestId("suppression-banner")).toBeHidden();

  // Chat with the agent.
  await page.getByRole("tab", { name: "Chat" }).click();
  await page.getByLabel("Message to the agent").fill("status");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-thread")).toContainText("Angeles foothills");
  await expect(page.getByTestId("voice-status")).toBeVisible();
  await page.screenshot({ path: "../out/demo-6-contained.png" });

  expect(errors).toEqual([]);
});
