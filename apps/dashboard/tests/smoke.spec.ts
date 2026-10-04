import { expect, test } from '@playwright/test';
import { collectErrors, expectMapAlive, openZone, signIn } from './helpers';

// Default Cesium widgets that must stay off.
const DEFAULT_WIDGETS = [
    '.cesium-viewer-animationContainer',
    '.cesium-viewer-timelineContainer',
    '.cesium-baseLayerPicker-selected',
    '.cesium-viewer-geocoderContainer',
    '.cesium-home-button',
    '.cesium-sceneModePicker-wrapper',
    '.cesium-navigationHelpButton-wrapper',
    '.cesium-viewer-fullscreenContainer',
    '.cesium-infoBox',
    '.cesium-selection-wrapper',
].join(', ');

test('signs in, lists watch zones and filters them', async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page);

    for (const name of [
        'Angeles foothills',
        'Santa Cruz Mountains',
        'Boulder foothills',
        'Giant Forest',
        'Huron-Manistee',
    ]) {
        await expect(page.getByRole('link', { name: `Open ${name}` })).toBeVisible();
    }
    await page.getByRole('radio', { name: /Active fire/ }).click();
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(1);
    await page.getByRole('radio', { name: /^All/ }).click();
    await page.getByLabel('Search watch zones').fill('boulder');
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(1);
    await page.getByLabel('Search watch zones').fill('nowhere');
    await expect(page.getByText('No watch zones match')).toBeVisible();
    expect(errors).toEqual([]);
});

test('opens a zone top-down and switches overlays', async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page);
    await openZone(page, 'Angeles foothills');
    await expect(page.locator(DEFAULT_WIDGETS)).toHaveCount(0);

    // A zone with past scans opens on the detection map.
    await expect(page.getByRole('radio', { name: 'Detection' })).toHaveAttribute(
        'aria-checked',
        'true',
    );
    await expect(page.getByText('Not yet mapped')).toBeVisible();

    await page.getByRole('radio', { name: 'Operator' }).click();
    await expect(page.getByText('Connectivity radius')).toBeVisible();

    await page.getByRole('switch', { name: 'Suggestions overlay' }).click();
    await expect(page.getByText('Evacuation route')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Detection' })).toHaveAttribute(
        'aria-checked',
        'true',
    );

    // The camera looks straight down.
    const pitch = await page.evaluate(
        () =>
            (window as unknown as { __emberViewer: { camera: { pitch: number } } }).__emberViewer
                .camera.pitch,
    );
    expect(Math.abs(pitch + Math.PI / 2)).toBeLessThan(0.01);
    await expectMapAlive(page);
    expect(errors).toEqual([]);
});

test('inspects an edge server and a drone', async ({ page }) => {
    await signIn(page);
    await openZone(page, 'Angeles foothills');
    await page
        .getByRole('button', { name: /Edge servers/ })
        .first()
        .click();
    await expect(page.getByText(/Connected drones/)).toBeVisible();
    await page
        .getByRole('button', { name: /^Drones/ })
        .first()
        .click();
    await expect(page.getByText('Last reported position')).toBeVisible();
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await expect(page.getByText('Last reported position')).toBeHidden();
});
