import { expect, type Page } from '@playwright/test';

/** Collects console errors and uncaught exceptions for the whole test. */
export function collectErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

/** Signs in with the built-in demo account and waits for the zone list. */
export async function signIn(page: Page, opts: { reducedMotion?: boolean } = {}): Promise<void> {
    if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Fill in the demo account' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Watch zones' })).toBeVisible();
}

/** Opens a watch zone from the list and waits for its map. */
export async function openZone(page: Page, name: string): Promise<void> {
    await page.getByRole('link', { name: `Open ${name}` }).click();
    await expect(page.getByRole('heading', { level: 1, name }).first()).toBeVisible();
    await expect(page.locator("[data-map-ready='true'][data-visible='true']")).toBeAttached();
    await expect(page.locator('.cesium-widget canvas')).toBeVisible();
}

/** No Cesium render error panel: the map is still drawing. */
export async function expectMapAlive(page: Page): Promise<void> {
    await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0);
}
