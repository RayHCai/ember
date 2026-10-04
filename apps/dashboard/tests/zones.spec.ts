import { expect, test } from '@playwright/test';
import { collectErrors, expectMapAlive, signIn } from './helpers';

test('onboards a new watch zone: boundary, edge servers, drones', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await signIn(page, { reducedMotion: true });
    await page.getByRole('button', { name: 'New watch zone' }).first().click();
    await expect(page.getByRole('heading', { name: 'New watch zone' })).toBeVisible();
    await page.waitForTimeout(1500);

    await page.getByPlaceholder('e.g. Eaton Canyon').fill('Big Tujunga');
    const corners: [number, number][] = [
        [650, 250],
        [1050, 230],
        [1150, 550],
        [800, 720],
    ];
    for (const [x, y] of corners) {
        await page.mouse.click(x, y);
        await page.waitForTimeout(200);
    }
    await expect(page.getByText('Close the shape to fill it')).toBeVisible();
    await page.mouse.click(650, 250);
    await expect(page.getByText('Boundary ready')).toBeVisible();

    await page.getByRole('button', { name: 'Auto-fit to forest' }).click();
    await expect(page.getByText('Fitted to the forest edge')).toBeVisible();
    await page.getByRole('button', { name: 'Continue to edge servers' }).click();

    await page.getByRole('button', { name: 'Process' }).click();
    const deploy = page.getByRole('button', { name: /^Deploy \d+ servers?$/ });
    await expect(deploy).toBeVisible({ timeout: 10_000 });
    await deploy.click();
    await expect(page.getByRole('button', { name: 'Continue to drones' })).toBeVisible({
        timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Continue to drones' }).click();

    await page.getByRole('button', { name: 'Start pairing' }).click();
    await expect(page.getByText('Kestrel')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Stop pairing' }).click();
    await page.getByRole('button', { name: /Finish and open zone/ }).click();

    await expect(page.getByText('Awaiting scan')).toBeVisible();
    await expect(
        page.getByRole('heading', { level: 1, name: 'Big Tujunga' }).first(),
    ).toBeVisible();
    await expectMapAlive(page);
    expect(errors).toEqual([]);
});

test('a zone with only a boundary is complete enough to open', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Open Huron-Manistee' }).click();
    await expect(page.getByText('Finish setting up')).toBeVisible();
    await page.getByRole('button', { name: 'Place edge servers' }).first().click();
    await expect(page.getByRole('button', { name: 'Process' })).toBeVisible();
});
