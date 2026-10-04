import { expect, test } from '@playwright/test';
import { collectErrors, expectMapAlive, openZone, signIn } from './helpers';

test('a manual scan flies the fleet, maps the zone and reports detections', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await signIn(page);
    await openZone(page, 'Boulder foothills');

    await page.getByRole('button', { name: 'Run scan now' }).click();
    await expect(page.getByText(/Scanning Boulder foothills/)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Detection' })).toHaveAttribute(
        'aria-checked',
        'true',
    );
    await expect(page.getByText(/airborne/).first()).toBeVisible();
    await expect(page.getByText('At-risk area found')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Scan complete')).toBeVisible({ timeout: 70_000 });
    await expect(page.getByText(/Scanning Boulder foothills/)).toBeHidden();
    await expectMapAlive(page);
    expect(errors).toEqual([]);
});

test('planners fill the suggestions overlay', async ({ page }) => {
    await signIn(page);
    await openZone(page, 'Boulder foothills');
    await expect(page.getByRole('switch', { name: 'Suggestions overlay' })).toBeDisabled();
    await page.getByRole('button', { name: 'Run', exact: true }).first().click();
    await expect(page.getByText('Civilian path plan ready')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('switch', { name: 'Suggestions overlay' })).toHaveAttribute(
        'aria-checked',
        'true',
    );
});

test('suggests edge server placements when coverage is below 90%', async ({ page }) => {
    await signIn(page);
    await openZone(page, 'Boulder foothills');
    await page.getByRole('radio', { name: 'Operator' }).click();
    await expect(page.getByText('Coverage is below 90%')).toBeVisible();
    await page.getByRole('button', { name: 'Suggest placements' }).click();
    await page.getByRole('button', { name: /^Deploy \d+$/ }).click();
    await expect(page.getByText('Coverage is below 90%')).toBeHidden({ timeout: 15_000 });
});
