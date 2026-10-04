import { expect, type Page } from '@playwright/test';

// These tests run against the services (`docker compose up -d --build`), not a mock.

export const API_URL = process.env.EMBER_API_URL ?? 'http://localhost:4001';
export const DEMO_DATA_URL = process.env.EMBER_DEMO_DATA_URL ?? 'http://localhost:8090';

/** Collects console errors and uncaught exceptions for the whole test; map tiles may fail offline. */
export function collectErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource'))
            errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

export interface Account {
    name: string;
    email: string;
    password: string;
}

export function newAccount(): Account {
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    return {
        name: `Test operator ${tag}`,
        email: `operator-${tag}@ember.test`,
        password: 'wildfire-e2e',
    };
}

/** Creates an account through the sign-up form and waits for the zone list. */
export async function signUp(page: Page, account = newAccount()): Promise<Account> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Name').fill(account.name);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Watch zones' })).toBeVisible();
    return account;
}

/** The signed-in operator's session token, for calling the api directly. */
export async function token(page: Page): Promise<string> {
    const raw = await page.evaluate(() => window.localStorage.getItem('ember.session'));
    const session = raw ? (JSON.parse(raw) as { token?: string }) : null;
    if (!session?.token) throw new Error('not signed in');
    return session.token;
}

export async function apiCall<T>(
    page: Page,
    method: string,
    path: string,
    data?: unknown,
): Promise<T> {
    const res = await page.request.fetch(`${API_URL}${path}`, {
        method,
        data,
        headers: { Authorization: `Bearer ${await token(page)}` },
    });
    if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
    return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** No Cesium render error panel: the map is still drawing. */
export async function expectMapAlive(page: Page): Promise<void> {
    await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0);
}
