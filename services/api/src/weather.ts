import type { LatLng, Weather } from '@ember/contracts';
import type { Fetch } from './integrations.js';

export interface WeatherProvider {
    current(at: LatLng): Promise<Weather | null>;
}

/**
 * The scenario clock the fixture follows: `EMBER_SCENARIO_START` at process start, advancing
 * `EMBER_SCENARIO_SPEED` scenario seconds per second, the way demo-data's clock does.
 */
export class ScenarioClock {
    private readonly startedAt: number;

    constructor(
        readonly start: Date,
        readonly speed: number,
        private readonly now: () => number = Date.now,
    ) {
        this.startedAt = now();
    }

    scenarioTime(): Date {
        return new Date(this.start.getTime() + (this.now() - this.startedAt) * this.speed);
    }
}

type Row = [hst: string, windMps: number, fromDeg: number, gustMps: number, tC: number, rh: number];

/**
 * Approximate Kahului-area conditions through the Aug 8, 2023 downslope wind event, hourly-ish,
 * shaped after the public record: strong east-north-easterly trades with gusts past 25 m/s and
 * humidity falling into the 30s through the afternoon. Deterministic stand-in for demo-data's
 * ASOS feed when that is not running.
 */
const LAHAINA_2023: Row[] = [
    ['2023-08-08T06:00', 11, 70, 20, 24, 62],
    ['2023-08-08T09:00', 12, 72, 22, 26, 52],
    ['2023-08-08T12:00', 14, 72, 25, 29, 41],
    ['2023-08-08T14:00', 16, 70, 28, 30, 34],
    ['2023-08-08T15:00', 17, 68, 30, 30, 30],
    ['2023-08-08T16:00', 18, 70, 31, 29, 31],
    ['2023-08-08T18:00', 16, 72, 27, 27, 38],
    ['2023-08-08T21:00', 14, 74, 24, 26, 46],
    ['2023-08-09T06:00', 10, 75, 18, 24, 56],
    ['2023-08-09T12:00', 8, 70, 14, 28, 50],
];
const HST = '-10:00';
const RED_FLAG = [Date.parse('2023-08-07T15:00-10:00'), Date.parse('2023-08-09T18:00-10:00')];

export class FixtureWeather implements WeatherProvider {
    constructor(private readonly clock: ScenarioClock) {}

    async current(): Promise<Weather> {
        const t = this.clock.scenarioTime().getTime();
        const rows = LAHAINA_2023.map((r) => ({ at: Date.parse(r[0] + HST), r }));
        let i = rows.findLastIndex((x) => x.at <= t);
        if (i < 0) i = 0;
        const a = rows[i]!;
        const b = rows[Math.min(i + 1, rows.length - 1)]!;
        const f = b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 0;
        const lerp = (k: number) =>
            Math.round((a.r[k] as number) * (1 - f) * 10 + (b.r[k] as number) * f * 10) / 10;
        return {
            observedAt: new Date(t).toISOString(),
            windSpeedMps: lerp(1),
            windFromDeg: lerp(2),
            windGustMps: lerp(3),
            temperatureC: lerp(4),
            relativeHumidityPct: lerp(5),
            redFlagWarning: t >= RED_FLAG[0]! && t <= RED_FLAG[1]!,
            source: 'fixture:lahaina-2023-08-08 (approximate)',
        };
    }
}

type DemoDataWeatherBody = {
    station?: { id?: string };
    observation: {
        observed_at: string;
        temperature_c: number | null;
        relative_humidity_pct: number | null;
        wind_from_deg: number | null;
        wind_speed_mps: number | null;
        wind_gust_mps: number | null;
    } | null;
    fire_wind_from_deg?: number;
    red_flag_warning?: boolean;
};

/** demo-data's `/v1/context/weather` at its scenario clock. */
export class DemoDataWeather implements WeatherProvider {
    constructor(
        private readonly baseUrl: string,
        private readonly fetchImpl: Fetch = fetch,
    ) {}

    async current(): Promise<Weather | null> {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/context/weather`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`demo-data /v1/context/weather: ${res.status}`);
        const body = (await res.json()) as DemoDataWeatherBody;
        const o = body.observation;
        if (!o || o.wind_speed_mps === null) return null;
        return {
            observedAt: new Date(o.observed_at).toISOString(),
            windSpeedMps: o.wind_speed_mps,
            windFromDeg: o.wind_from_deg ?? body.fire_wind_from_deg ?? 0,
            windGustMps: o.wind_gust_mps,
            temperatureC: o.temperature_c,
            relativeHumidityPct: o.relative_humidity_pct,
            redFlagWarning: body.red_flag_warning ?? null,
            source: `demo-data:${body.station?.id ?? 'station'}`,
        };
    }
}

type Quantity = { value: number | null; unitCode?: string };

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** NWS: latest observation at the nearest station, plus active Red Flag Warnings at the point. */
export class NwsWeather implements WeatherProvider {
    private readonly stations = new Map<string, string>();

    constructor(
        private readonly userAgent: string,
        private readonly fetchImpl: Fetch = fetch,
        private readonly baseUrl = 'https://api.weather.gov',
    ) {}

    private async get<T>(path: string): Promise<T> {
        const res = await this.fetchImpl(path.startsWith('http') ? path : this.baseUrl + path, {
            headers: { 'user-agent': this.userAgent, accept: 'application/geo+json' },
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`nws ${path}: ${res.status}`);
        return (await res.json()) as T;
    }

    private async station(at: LatLng): Promise<string> {
        const key = `${at.lat.toFixed(3)},${at.lng.toFixed(3)}`;
        const cached = this.stations.get(key);
        if (cached) return cached;
        const point = await this.get<{ properties: { observationStations: string } }>(
            `/points/${at.lat.toFixed(4)},${at.lng.toFixed(4)}`,
        );
        const list = await this.get<{ features: { properties: { stationIdentifier: string } }[] }>(
            point.properties.observationStations,
        );
        const id = list.features[0]?.properties.stationIdentifier;
        if (!id) throw new Error(`nws: no observation station near ${key}`);
        this.stations.set(key, id);
        return id;
    }

    async current(at: LatLng): Promise<Weather | null> {
        const id = await this.station(at);
        const obs = await this.get<{
            properties: {
                timestamp: string;
                windSpeed: Quantity;
                windDirection: Quantity;
                windGust: Quantity;
                temperature: Quantity;
                relativeHumidity: Quantity;
            };
        }>(`/stations/${id}/observations/latest`);
        const alerts = await this.get<{ features: { properties: { event: string } }[] }>(
            `/alerts/active?point=${at.lat.toFixed(4)},${at.lng.toFixed(4)}`,
        );
        const p = obs.properties;
        const mps = (q: Quantity) =>
            q.value === null ? null : q.unitCode?.endsWith('km_h-1') ? q.value / 3.6 : q.value;
        const wind = mps(p.windSpeed);
        if (wind === null) return null;
        return {
            observedAt: new Date(p.timestamp).toISOString(),
            windSpeedMps: round(wind)!,
            windFromDeg: p.windDirection.value ?? 0,
            windGustMps: round(mps(p.windGust)),
            temperatureC: round(p.temperature.value),
            relativeHumidityPct: round(p.relativeHumidity.value),
            redFlagWarning: alerts.features.some((f) => f.properties.event === 'Red Flag Warning'),
            source: `nws:${id}`,
        };
    }
}
