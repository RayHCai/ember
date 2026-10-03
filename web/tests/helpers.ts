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

/** Screen position of the first visible (airborne) drone, read from the Cesium scene. */
export async function airborneDroneOnScreen(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    type V = {
      clock: { currentTime: unknown };
      canvas: { clientWidth: number; clientHeight: number };
      dataSources: { getByName(n: string): { entities: { values: { id: string; show: boolean; position: { getValue(t: unknown): unknown } }[] } }[] };
      scene: { cartesianToCanvasCoordinates(p: unknown): { x: number; y: number } | undefined };
    };
    const viewer = (window as unknown as { __emberViewer?: V }).__emberViewer;
    const ds = viewer?.dataSources.getByName("drones")[0];
    if (!viewer || !ds) return null;
    for (const e of ds.entities.values) {
      if (!e.id.startsWith("drone:") || !e.show) continue;
      const p = viewer.scene.cartesianToCanvasCoordinates(e.position.getValue(viewer.clock.currentTime));
      // Skip drones hidden under the side panels.
      if (p && p.x > 300 && p.x < viewer.canvas.clientWidth - 380 && p.y > 80 && p.y < viewer.canvas.clientHeight - 120) {
        return { x: p.x, y: p.y };
      }
    }
    return null;
  });
}
