export type { LatLng, RiskLevel } from './common.js';
export * from './droneInfo.js';
export * from './droneLink.js';
export type { Civilian, CreateCivilianRequest } from './civilian.js';

/** Every service answers this path for liveness. */
export const SERVICE_HEALTH_PATH = '/healthz';

export type WatchZoneId = string & { readonly __brand: 'WatchZoneId' };

/** Sent API -> edge manager to start or stop a mapping run across a zone's edge servers. */
export type EdgeTask = {
    zoneId: WatchZoneId;
    kind: 'start_mapping' | 'stop_mapping';
    edgeServerUrls: string[];
};
