import { expect, type Page } from "@playwright/test";

/** Collects console errors and uncaught exceptions for the whole test. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

export async function openConsole(page: Page, opts: { reducedMotion?: boolean } = {}): Promise<void> {
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("main[data-globe-ready='true']")).toBeAttached();
  await expect(page.locator(".cesium-widget canvas")).toBeVisible();
}

/** Waits until the globe has finished loading the tiles in view. */
export async function waitForTiles(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const viewer = (window as unknown as { __emberViewer?: { scene: { globe: { tilesLoaded: boolean } } } })
        .__emberViewer;
      return viewer?.scene.globe.tilesLoaded === true;
    },
    undefined,
    { timeout: timeoutMs, polling: 250 },
  );
}
