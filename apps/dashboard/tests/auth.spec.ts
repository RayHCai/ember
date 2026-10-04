import { expect, test } from '@playwright/test';
import { collectErrors, signUp } from './helpers';

test('signs up, signs out and signs back in; the session survives a reload', async ({ page }) => {
    const errors = collectErrors(page);
    const account = await signUp(page);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Watch zones' })).toBeVisible();

    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('wrong email or password');

    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Watch zones' })).toBeVisible();
    expect(errors).toEqual([]);
});

test('an email can only sign up once', async ({ page }) => {
    const account = await signUp(page);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Name').fill('Someone else');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill('another-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
});

test('the sign-in form checks its fields before calling the api', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('textbox')).toHaveCount(2);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Enter a valid email address.');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByRole('textbox')).toHaveCount(3);
    await page.getByLabel('Name').fill('Someone');
    await page.getByLabel('Email').fill('someone@ember.test');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('Use at least 8 characters.');
});

test('the session times out after a week', async ({ page }) => {
    await signUp(page);
    await page.evaluate(() => {
        const session = JSON.parse(window.localStorage.getItem('ember.session')!) as {
            expiresAt: number;
        };
        session.expiresAt = Date.now() - 1000;
        window.localStorage.setItem('ember.session', JSON.stringify(session));
    });
    await page.reload();
    await expect(
        page.getByText('Your session timed out after a week. Sign in again.'),
    ).toBeVisible();
});
