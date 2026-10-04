import type { WatchZone } from '@ember/contracts';
import type { Keys } from './auth.js';
import { notFound } from './errors.js';
import type { EdgeManager, PlannerQueue } from './integrations.js';
import type { StoredGeography, Store } from './store/index.js';
import type { WeatherProvider } from './weather.js';

export type ApiConfig = {
    /** The api URL phones and texts are given. */
    publicApiUrl: string;
    /** drone-info URL handed to paired responder apps. */
    droneInfoUrl: string | null;
    /** Mapping cell size sent to edge servers. */
    scanCellSizeM: number;
};

export type Deps = {
    store: Store;
    queue: PlannerQueue;
    edge: EdgeManager;
    weather: WeatherProvider;
    keys: Keys;
    config: ApiConfig;
    now: () => Date;
};

export async function requireZone(store: Store, zoneId: string): Promise<WatchZone> {
    const zone = await store.zones.get(zoneId);
    if (!zone) throw notFound(`watch zone ${zoneId}`);
    return zone;
}

export async function geographyOf(store: Store, zone: WatchZone): Promise<StoredGeography> {
    return (
        (await store.geography.get(zone.id)) ?? {
            zoneId: zone.id,
            terrain: null,
            roads: [],
            civilianAreas: [],
            safeZones: [],
            stations: [],
        }
    );
}

export const iso = (d: Date) => d.toISOString();
