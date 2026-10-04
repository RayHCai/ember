import type { LatLng, WatchZoneId } from './common.js';
import type {
    AttackZone,
    CivilianArea,
    FireIsochrone,
    FireSpreadForecast,
    PlannerDetection,
    PlannerRiskZone,
    ResponderStation,
    Road,
    SafeZone,
    TerrainGrid,
    Weather,
} from './planner.js';

/**
 * Responder plane: how the responder app joins a watch zone and stays current.
 *
 * - The dashboard shows a QR code whose text is a `ResponderPairingCode` as JSON.
 * - The app trades its `token` at api `POST ${RESPONDER_PAIR_PATH}` for a `ResponderSession`.
 * - With `Authorization: Bearer <sessionToken>` it downloads the zone at api
 *   `GET ${RESPONDER_BUNDLE_PATH}`, sending `If-None-Match: <version>`; api answers 304 when the
 *   bundle is unchanged. The app keeps the last bundle on disk and works from it offline.
 * - Operator messages arrive in the bundle's `messages`.
 *
 * Paths use Fastify parameter syntax.
 */
export const RESPONDER_PAIR_PATH = '/v1/responders/pair';
export const RESPONDER_BUNDLE_PATH = '/v1/responders/zones/:zoneId/bundle';

export const RESPONDER_PAIRING_KIND = 'ember.responder.pair';

/** The QR code's text. Short-lived and single-zone; the session it yields is what lasts. */
export type ResponderPairingCode = {
    kind: typeof RESPONDER_PAIRING_KIND;
    v: 1;
    apiUrl: string;
    zoneId: WatchZoneId;
    zoneName: string;
    token: string;
    expiresAt: string;
};

/** app -> api. */
export type ResponderPairRequest = {
    token: string;
    deviceName: string;
    platform: 'ios' | 'android' | 'web';
};

/** api -> app. The other services' URLs come from here, never from the QR code. */
export type ResponderSession = {
    responderId: string;
    sessionToken: string;
    zoneId: WatchZoneId;
    zoneName: string;
    apiUrl: string;
    droneInfoUrl: string | null;
};

/** The planner's latest result, trimmed to what a phone draws. */
export type ResponderPlan = {
    jobId: string;
    generatedAt: string;
    horizonMin: number;
    isochrones: FireIsochrone[];
    track: FireSpreadForecast['track'];
    headingDeg: number | null;
    maxSpreadMpm: number;
    attackZones: AttackZone[];
};

export type ResponderMessageKind = 'incident' | 'update' | 'plan' | 'directive' | 'all_clear';

export type ResponderMessagePriority = 'routine' | 'urgent' | 'critical';

/** Operator or dashboard -> every responder of a zone. */
export type ResponderMessage = {
    id: string;
    zoneId: WatchZoneId;
    kind: ResponderMessageKind;
    priority: ResponderMessagePriority;
    title: string;
    body: string;
    sentAt: string;
    /** Operator name, or `ember` for automatic events. */
    from: string;
    location: LatLng | null;
};

/** Everything the app needs to work a zone with no network. */
export type ResponderZoneBundle = {
    zoneId: WatchZoneId;
    name: string;
    /** Opaque; changes whenever any field does. Sent back as `If-None-Match`. */
    version: string;
    generatedAt: string;
    boundary: LatLng[];
    terrain: TerrainGrid | null;
    roads: Road[];
    civilianAreas: CivilianArea[];
    safeZones: SafeZone[];
    stations: ResponderStation[];
    weather: Weather | null;
    riskZones: PlannerRiskZone[];
    detections: PlannerDetection[];
    plan: ResponderPlan | null;
    /** Recent messages, newest first, so a fresh install has context before its first push. */
    messages: ResponderMessage[];
};
