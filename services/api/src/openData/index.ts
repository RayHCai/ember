import { createForestFit } from './forestFit.js';
import { createOverpass } from './overpass.js';
import { createSurroundings } from './surroundings.js';
import type { OpenData } from './types.js';
import { createWeather } from './weather.js';

export { OpenDataError } from './types.js';
export type { FetchedSurroundings, OpenData } from './types.js';

export type OpenDataOptions = {
    fetch?: typeof fetch;
    overpassUrl?: string;
    openMeteoUrl?: string;
    /** Limit for one Overpass request; weather is held to the lower of this and 4 s. */
    timeoutMs?: number;
    userAgent?: string;
};

const OVERPASS_TIMEOUT_MS = 25_000;
const WEATHER_TIMEOUT_MS = 4_000;

export function createOpenData(options: OpenDataOptions = {}): OpenData {
    // Looked up per call so a fetch stubbed after startup is still honoured.
    const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const userAgent = options.userAgent ?? 'ember-api (wildfire watch zones)';
    const overpassTimeoutMs = options.timeoutMs ?? OVERPASS_TIMEOUT_MS;

    const overpass = createOverpass({
        fetch: fetchImpl,
        url:
            options.overpassUrl ??
            process.env.EMBER_OVERPASS_URL ??
            'https://overpass-api.de/api/interpreter',
        timeoutMs: overpassTimeoutMs,
        userAgent,
    });

    return {
        fitForest: createForestFit(overpass),
        surroundings: createSurroundings(overpass),
        weather: createWeather({
            fetch: fetchImpl,
            url:
                options.openMeteoUrl ??
                process.env.EMBER_OPEN_METEO_URL ??
                'https://api.open-meteo.com/v1/forecast',
            timeoutMs: Math.min(overpassTimeoutMs, WEATHER_TIMEOUT_MS),
            userAgent,
        }),
    };
}
