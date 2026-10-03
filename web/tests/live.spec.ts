import { expect, test } from "@playwright/test";
import { LIVE_PORT } from "../playwright.config";
import { TestServer } from "./server";

test.use({ baseURL: `http://localhost:${LIVE_PORT}` });

test("connects to the server, ticks sim time, and reconnects after a restart", async ({ page }) => {
  const server = new TestServer({ EMBER_SIM_SPEED: "60" });
  await server.start();
  try {
    await page.goto("/");
    const connection = (label: string) => page.getByText(label, { exact: true });
    await expect(connection("Live")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("No watch zone yet").first()).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "../out/qa-empty.png" });

    const simTime = page.getByTestId("sim-time");
    const first = await simTime.textContent();
    await expect(simTime).not.toHaveText(first ?? "", { timeout: 5000 });

    // Speed buttons round-trip through the server and come back as a sim event.
    await expect(page.getByRole("button", { name: "60x", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "360x", exact: true }).click();
    await expect(page.getByRole("button", { name: "360x", exact: true })).toHaveAttribute("aria-pressed", "true");

    await server.stop();
    await expect(connection("Reconnecting")).toBeVisible({ timeout: 10_000 });

    await server.start();
    await expect(connection("Live")).toBeVisible({ timeout: 15_000 });
    // A restarted server sends a new snapshot with its own clock (60x again).
    await expect(page.getByRole("button", { name: "60x", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await server.stop();
  }
});
