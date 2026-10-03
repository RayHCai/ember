import { expect, test } from 'vitest';
import { buildApp } from './app.js';

test('health', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ service: 'voice-agent', ok: true });
});
