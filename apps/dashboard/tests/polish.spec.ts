import { expect, test } from '@playwright/test';
import { collectErrors, signIn } from './helpers';

test('rejects a wrong password and creates an account', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email', { exact: true }).fill('operator@ember.dev');
    await page.getByLabel('Password', { exact: true }).fill('not-it');
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByRole('alert')).toContainText('That password is not right.');

    await page.getByRole('radio', { name: 'Create account' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Alex Rivera');
    await page.getByLabel('Email', { exact: true }).fill('alex@example.org');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
    await expect(page.getByRole('alert')).toContainText('at least 8 characters');
    await page.getByLabel('Password', { exact: true }).fill('long-enough');
    await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
    await expect(page.getByText('Good', { exact: false })).toContainText('Alex');
});

test('the session survives a reload and times out after a week', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Watch zones' })).toBeVisible();

    await page.evaluate(() => {
        const raw = window.localStorage.getItem('ember.session')!;
        const session = JSON.parse(raw) as { expiresAt: number };
        session.expiresAt = Date.now() - 1000;
        window.localStorage.setItem('ember.session', JSON.stringify(session));
    });
    await page.reload();
    await expect(
        page.getByText('Your session timed out after a week. Sign in again.'),
    ).toBeVisible();
});

test('signs out from the account menu', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('works with reduced motion and no console errors', async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page, { reducedMotion: true });
    await page.getByRole('link', { name: 'Open Santa Cruz Mountains' }).click();
    await expect(
        page.getByRole('heading', { level: 1, name: 'Santa Cruz Mountains' }).first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
});
