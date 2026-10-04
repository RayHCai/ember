import type { Weather } from '@ember/contracts';
import type { OpenData } from './types.js';

export type WeatherOptions = {
    fetch: typeof fetch;
    url: string;
    timeoutMs: number;
    userAgent: string;
};

const CURRENT = 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const numberOrNull = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

function toWeather(json: unknown): Weather | null {
    const current = isRecord(json) ? json.current : null;
    if (!isRecord(current) || typeof current.time !== 'string') return null;
    // timezone=GMT, so the bare local time is UTC.
    const observed = new Date(
        /(Z|[+-]\d\d:?\d\d)$/.test(current.time) ? current.time : `${current.time}Z`,
    );
    const windSpeedMps = numberOrNull(current.wind_speed_10m);
    const windFromDeg = numberOrNull(current.wind_direction_10m);
    if (Number.isNaN(observed.getTime()) || windSpeedMps === null || windFromDeg === null) {
        return null;
    }
    return {
        observedAt: observed.toISOString(),
        windSpeedMps,
        windFromDeg,
        temperatureC: numberOrNull(current.temperature_2m),
        relativeHumidityPct: numberOrNull(current.relative_humidity_2m),
    };
}

export function createWeather(options: WeatherOptions): OpenData['weather'] {
    return async (at) => {
        try {
            const url = new URL(options.url);
            url.searchParams.set('latitude', String(at.lat));
            url.searchParams.set('longitude', String(at.lng));
            url.searchParams.set('current', CURRENT);
            url.searchParams.set('wind_speed_unit', 'ms');
            url.searchParams.set('timezone', 'GMT');
            const response = await options.fetch(url, {
                headers: { accept: 'application/json', 'user-agent': options.userAgent },
                signal: AbortSignal.timeout(options.timeoutMs),
            });
            if (!response.ok) return null;
            return toWeather(await response.json());
        } catch {
            return null;
        }
    };
}
