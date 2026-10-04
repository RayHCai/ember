import { expect, test } from 'vitest';
import type { LatLng } from '@ember/contracts';
import { OpenDataError, createOpenData } from './index.js';

const boundary: LatLng[] = [
    { lat: 20.878, lng: -156.658 },
    { lat: 20.878, lng: -156.652 },
    { lat: 20.872, lng: -156.652 },
    { lat: 20.872, lng: -156.658 },
];

const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

const answering = (response: () => Response | Promise<Response>): typeof fetch => {
    return async () => response();
};

test('a 504 from Overpass is an OpenDataError', async () => {
    const data = createOpenData({
        fetch: answering(() => new Response('gateway timeout', { status: 504 })),
    });
    await expect(data.surroundings(boundary)).rejects.toThrow(OpenDataError);
    await expect(data.fitForest(boundary)).rejects.toThrow(/HTTP 504/);
});

test('a network failure is an OpenDataError', async () => {
    const data = createOpenData({
        fetch: answering(() => {
            throw new TypeError('fetch failed');
        }),
    });
    await expect(data.fitForest(boundary)).rejects.toThrow(OpenDataError);
});

test('a body that is not JSON is an OpenDataError', async () => {
    const data = createOpenData({ fetch: answering(() => new Response('<html>busy</html>')) });
    await expect(data.fitForest(boundary)).rejects.toThrow(/not JSON/);
});

test('JSON without elements is an OpenDataError', async () => {
    const data = createOpenData({ fetch: answering(() => Response.json({ version: 0.6 })) });
    await expect(data.fitForest(boundary)).rejects.toThrow(OpenDataError);
});

test('a runtime error remark on a 200 is an OpenDataError', async () => {
    const data = createOpenData({
        fetch: answering(() =>
            Response.json({ elements: [], remark: 'runtime error: Query timed out in "query"' }),
        ),
    });
    await expect(data.surroundings(boundary)).rejects.toThrow(/timed out/);
});

test('a request that never answers is an OpenDataError after the timeout', async () => {
    const data = createOpenData({ fetch: hang, timeoutMs: 30 });
    await expect(data.fitForest(boundary)).rejects.toThrow(/no answer/);
});

test('the query goes out as a form-encoded POST with the configured user agent', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const data = createOpenData({
        overpassUrl: 'https://overpass.test/api',
        userAgent: 'test-agent',
        fetch: async (input, init) => {
            seen.push({ url: String(input), init });
            return Response.json({ elements: [] });
        },
    });
    await data.surroundings(boundary);

    const [call] = seen;
    expect(call?.url).toBe('https://overpass.test/api');
    expect(call?.init?.method).toBe('POST');
    expect(new Headers(call?.init?.headers).get('user-agent')).toBe('test-agent');
    expect(new Headers(call?.init?.headers).get('content-type')).toBe(
        'application/x-www-form-urlencoded',
    );
    const query = new URLSearchParams(String(call?.init?.body)).get('data');
    expect(query).toMatch(/^\[out:json\]\[timeout:25\];/);
});
