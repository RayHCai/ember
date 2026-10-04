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
/** Operator -> api: mint a `ResponderPairingCode` for the zone's QR. */
export const RESPONDER_PAIRING_CODES_PATH = '/v1/watch-zones/:zoneId/responder-pairing-codes';
export const ZONE_RESPONDERS_PATH = '/v1/watch-zones/:zoneId/responders';
export const RESPONDER_PATH = '/v1/responders/:responderId';
export const ZONE_ASSIGNMENTS_PATH = '/v1/watch-zones/:zoneId/assignments';
export const ZONE_RESPONDER_MESSAGES_PATH = '/v1/watch-zones/:zoneId/responder-messages';

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

/** Pairs a new responder, or the existing `responderId` on a new device. */
export type CreatePairingCodeRequest = { responderId?: string };

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

/** Operator, dashboard or operator-agent -> every responder of a zone, or one. */
export type ResponderMessage = {
    id: string;
    zoneId: WatchZoneId;
    /** Null: the whole zone. */
    responderId: string | null;
    kind: ResponderMessageKind;
    priority: ResponderMessagePriority;
    title: string;
    body: string;
    sentAt: string;
    /** Operator name, or `ember` for automatic events. */
    from: string;
    location: LatLng | null;
};

export type SendResponderMessageRequest = Omit<ResponderMessage, 'id' | 'zoneId' | 'sentAt'>;

export type ResponderAvailability = 'available' | 'assigned' | 'unavailable';

export type ResponderStatus = 'idle' | 'en_route' | 'on_scene' | 'returning' | 'off_duty';

export type Responder = {
    id: string;
    /** Sequential across Ember: "Responder 2". */
    number: number;
    zoneId: WatchZoneId;
    name: string;
    /** e.g. `engine`, `hand_crew`, `dozer`, `medic`. */
    role: string;
    capabilities: string[];
    stationId: string | null;
    location: LatLng | null;
    availability: ResponderAvailability;
    status: ResponderStatus;
    updatedAt: string;
};

export type CreateResponderRequest = Pick<
    Responder,
    'name' | 'role' | 'capabilities' | 'stationId' | 'location'
>;

export type UpdateResponderRequest = Partial<
    Pick<Responder, 'location' | 'availability' | 'status'>
>;

export type ResponderAssignmentState = 'active' | 'superseded' | 'completed' | 'cancelled';

/** One responder sent to one attack zone of one plan. */
export type ResponderAssignment = {
    id: string;
    responderId: string;
    zoneId: WatchZoneId;
    incidentId: string | null;
    jobId: string;
    attackZoneId: string;
    /** Letter the plan's rank maps to: rank 1 is `A`. */
    attackZoneLabel: string;
    dropSite: LatLng;
    /** Built from the plan: incident, zone, drop-site road, approach bearing, fire arrival. */
    instructions: string;
    state: ResponderAssignmentState;
    createdAt: string;
    updatedAt: string;
};

/**
 * Assigns available responders to the plan's attack zones in rank order, preferring the station
 * each zone's approach starts from. Earlier active assignments of the same incident to zones the
 * new plan no longer has, or whose drop site or approach changed, are superseded.
 */
export type AssignRespondersRequest = {
    jobId: string;
    incidentId?: string;
    /** Default: every attack zone of the plan. */
    attackZoneIds?: string[];
    /** Default 1. */
    perZone?: number;
};

export type AssignRespondersResult = {
    assignments: ResponderAssignment[];
    superseded: ResponderAssignment[];
    /** Attack zones left without a responder. */
    unassigned: string[];
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
    /** Recent messages for the zone or this responder, newest first. */
    messages: ResponderMessage[];
    /** This responder's active assignment. */
    assignment: ResponderAssignment | null;
};
