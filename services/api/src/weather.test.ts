import { expect, test } from 'vitest';
import { DemoDataWeather, FixtureWeather, NwsWeather, ScenarioClock } from './weather.js';

const LAHAINA = { lat: 20.875, lng: -156.675 };

function json(routes: Record<string, unknown>): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = String(input);
        const key = Object.keys(routes).find((k) => url.includes(k));
        if (!key) return new Response('missing', { status: 404 });
        return Response.json(routes[key]);
    }) as typeof fetch;
}

test('the fixture follows the scenario clock and worsens into the afternoon', async () => {
    let now = 0;
    const clock = new ScenarioClock(new Date('2023-08-08T12:00:00-10:00'), 60, () => now);
    const weather = new FixtureWeather(clock);
    const noon = await weather.current();
    now = 3 * 60 * 1000;
    const three = await weather.current();
    expect(three.observedAt).toBe('2023-08-09T01:00:00.000Z');
    expect(three.windSpeedMps).toBeGreaterThan(noon.windSpeedMps);
    expect(three.relativeHumidityPct!).toBeLessThan(noon.relativeHumidityPct!);
    expect(three).toMatchObject({ windSpeedMps: 17, windFromDeg: 68, redFlagWarning: true });
});

test('demo-data observations map to Weather', async () => {
    const weather = new DemoDataWeather(
        'http://demo',
        json({
            '/v1/context/weather': {
                station: { id: 'PHOG' },
                observation: {
                    observed_at: '2023-08-08T15:00:00-10:00',
                    temperature_c: 30.6,
                    relative_humidity_pct: 31,
                    wind_from_deg: 80,
                    wind_speed_mps: 13.4,
                    wind_gust_mps: 26.8,
                },
                fire_wind_from_deg: 70,
                red_flag_warning: true,
            },
        }),
    );
    expect(await weather.current()).toEqual({
        observedAt: '2023-08-09T01:00:00.000Z',
        windSpeedMps: 13.4,
        windFromDeg: 80,
        windGustMps: 26.8,
        temperatureC: 30.6,
        relativeHumidityPct: 31,
        redFlagWarning: true,
        source: 'demo-data:PHOG',
    });
});

test('NWS converts km/h and reads Red Flag Warnings at the point', async () => {
    const weather = new NwsWeather(
        'ember test',
        json({
            '/points/': { properties: { observationStations: 'https://nws/stations-list' } },
            'stations-list': { features: [{ properties: { stationIdentifier: 'PHJH' } }] },
            '/stations/PHJH/observations/latest': {
                properties: {
                    timestamp: '2023-08-08T20:00:00+00:00',
                    windSpeed: { value: 36, unitCode: 'wmoUnit:km_h-1' },
                    windDirection: { value: 70 },
                    windGust: { value: null },
                    temperature: { value: 29.4 },
                    relativeHumidity: { value: 33.21 },
                },
            },
            '/alerts/active': { features: [{ properties: { event: 'Red Flag Warning' } }] },
        }),
    );
    expect(await weather.current(LAHAINA)).toMatchObject({
        windSpeedMps: 10,
        windGustMps: null,
        relativeHumidityPct: 33.2,
        redFlagWarning: true,
        source: 'nws:PHJH',
    });
});
