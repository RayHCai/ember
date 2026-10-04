import { expect, test } from 'vitest';
import { createOpenData } from './index.js';

const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

const at = { lat: 20.875, lng: -156.655 };
const current = {
    time: '2026-10-04T14:30',
    temperature_2m: 27.4,
    relative_humidity_2m: 38,
    wind_speed_10m: 6.2,
    wind_direction_10m: 70,
};

test('current conditions map to Weather', async () => {
    const urls: string[] = [];
    const data = createOpenData({
        openMeteoUrl: 'https://meteo.test/v1/forecast',
        fetch: async (input) => {
            urls.push(String(input));
            return Response.json({ current });
        },
    });
    const weather = await data.weather(at);

    expect(weather).toEqual({
        observedAt: '2026-10-04T14:30:00.000Z',
        windSpeedMps: 6.2,
        windFromDeg: 70,
        temperatureC: 27.4,
        relativeHumidityPct: 38,
    });
    const url = new URL(urls[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://meteo.test/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('20.875');
    expect(url.searchParams.get('longitude')).toBe('-156.655');
    expect(url.searchParams.get('current')).toBe(
        'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m',
    );
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(url.searchParams.get('timezone')).toBe('GMT');
});

test('missing temperature and humidity are null', async () => {
    const data = createOpenData({
        fetch: async () =>
            Response.json({
                current: { ...current, temperature_2m: null, relative_humidity_2m: undefined },
            }),
    });
    const weather = await data.weather(at);
    expect(weather?.temperatureC).toBeNull();
    expect(weather?.relativeHumidityPct).toBeNull();
    expect(weather?.windSpeedMps).toBe(6.2);
});

test('an HTTP 500 is null', async () => {
    const data = createOpenData({ fetch: async () => new Response('boom', { status: 500 }) });
    expect(await data.weather(at)).toBeNull();
});

test('a network failure is null and never throws', async () => {
    const data = createOpenData({
        fetch: async () => {
            throw new TypeError('fetch failed');
        },
    });
    expect(await data.weather(at)).toBeNull();
});

test('a body without wind is null', async () => {
    const data = createOpenData({
        fetch: async () => Response.json({ current: { time: current.time, temperature_2m: 20 } }),
    });
    expect(await data.weather(at)).toBeNull();
    const garbled = createOpenData({ fetch: async () => new Response('not json') });
    expect(await garbled.weather(at)).toBeNull();
});

test('a slow answer is null after the timeout', async () => {
    const data = createOpenData({ fetch: hang, timeoutMs: 30 });
    expect(await data.weather(at)).toBeNull();
});
