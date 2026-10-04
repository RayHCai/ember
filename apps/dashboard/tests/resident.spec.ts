import { expect, test } from '@playwright/test';
import { collectErrors, openZone, signIn } from './helpers';

// Outbound civilian alerts need an operator approval record; responder messages do not.

test('a civilian blast is sent only after hold-to-approve', async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page);
    await openZone(page, 'Angeles foothills');
    await page.getByRole('button', { name: 'Event blast' }).click();
    const dialog = page.getByRole('dialog', { name: 'Event blast' });
    await dialog.getByRole('radio', { name: 'Civilians' }).click();
    await dialog.getByRole('button', { name: 'Evacuate now' }).click();
    await dialog.getByRole('button', { name: 'Review for approval' }).click();

    const approve = page.getByRole('dialog', { name: 'Approve civilian alert' });
    await expect(approve.getByText('Civilian alerts need an operator approval')).toBeVisible();
    const hold = approve.getByRole('button', { name: 'Hold to approve and send' });
    // A quick click is not an approval.
    await hold.click();
    await expect(approve).toBeVisible();

    const box = (await hold.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1600);
    await page.mouse.up();
    await expect(page.getByText(/is on its way/)).toBeVisible();
    await expect(page.getByText(/Approved by Demo operator/)).toBeVisible();
    expect(errors).toEqual([]);
});

test('a responder-only blast sends directly', async ({ page }) => {
    await signIn(page);
    await openZone(page, 'Angeles foothills');
    await page.getByRole('button', { name: 'Event blast' }).click();
    const dialog = page.getByRole('dialog', { name: 'Event blast' });
    await dialog.getByRole('radio', { name: 'Responders' }).click();
    await dialog.getByRole('button', { name: 'Update' }).click();
    await dialog.getByRole('button', { name: /Send to \d+ responders/ }).click();
    await expect(page.getByText(/responders by push/)).toBeVisible();
});

test('the operator agent drafts evacuation texts for approval', async ({ page }) => {
    await signIn(page);
    await openZone(page, 'Angeles foothills');
    await page.getByRole('button', { name: 'Operator Agent' }).click();
    await page
        .getByLabel('Message the Operator Agent')
        .fill('Text everyone within 2 mi of the fire to evacuate via Route 9');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Nothing goes to civilians until you approve it/)).toBeVisible();
    await page.getByRole('button', { name: /Review and approve/ }).click();
    await expect(page.getByRole('dialog', { name: 'Approve civilian alert' })).toBeVisible();
});

test('the responder QR code pairs a phone', async ({ page }) => {
    await signIn(page);
    await openZone(page, 'Angeles foothills');
    await page.getByRole('button', { name: 'Connect responder' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect a responder' });
    await expect(dialog.locator('svg path').first()).toBeAttached();
    await expect(dialog.getByText(/Expires in/)).toBeVisible();
    await expect(dialog.getByText('Just joined')).toBeVisible({ timeout: 12_000 });
});
