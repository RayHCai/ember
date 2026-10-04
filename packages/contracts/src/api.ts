import type { LatLng, WatchZoneId } from './common.js';
import type { DroneDetections, DroneKind } from './droneInfo.js';
import type { EdgeRun, EdgeRunState, EdgeServerStatus, EdgeServerTaskResult } from './edge.js';
import type {
    CivilianArea,
    PlannerJobState,
    PlannerOptions,
    PlannerResult,
    PlannerRiskZone,
    ResponderStation,
    Road,
    SafeZone,
    Weather,
} from './planner.js';

/**
 * The api's records over HTTP. Every `/v1` route below needs `Authorization: Bearer <token>`: an
 * operator's session token, `EMBER_EDGE_KEY` or `EMBER_PLANNER_KEY`. The planner's own routes
 * (`planner.ts`) take only the planner key; sign-up and sign-in are open. Errors are `{ error }`
 * with a 4xx or 5xx status. Paths with `:param` use Fastify syntax.
 */
export const SIGN_UP_PATH = '/v1/auth/sign-up';
export const SIGN_IN_PATH = '/v1/auth/sign-in';
/** `GET` the caller's session, `DELETE` to sign out. */
export const SESSION_PATH = '/v1/auth/session';
export const WATCH_ZONES_PATH = '/v1/watch-zones';
export const ZONE_SUMMARIES_PATH = '/v1/watch-zones/summaries';
export const API_EDGE_SERVERS_PATH = '/v1/edge-servers';
export const ZONE_PLACEMENTS_PATH = '/v1/watch-zones/:zoneId/placements';
export const PLACEMENTS_PATH = '/v1/placements';
export const DRONES_PATH = '/v1/drones';
export const ZONE_SCANS_PATH = '/v1/watch-zones/:zoneId/scans';
export const MAPPING_RUNS_PATH = '/v1/mapping-runs';
export const DETECTIONS_PATH = '/v1/detections';
export const ZONE_RISK_ZONES_PATH = '/v1/watch-zones/:zoneId/risk-zones';
export const ZONE_SURROUNDINGS_PATH = '/v1/watch-zones/:zoneId/surroundings';
export const ZONE_WEATHER_PATH = '/v1/watch-zones/:zoneId/weather';
export const FOREST_FIT_PATH = '/v1/forest-fit';
export const PLANNER_JOBS_PATH = '/v1/planner/jobs';
export const ZONE_BLASTS_PATH = '/v1/watch-zones/:zoneId/blasts';
export const BLASTS_PATH = '/v1/blasts';
/**
 * `GET ${CIVILIANS_PATH}?zipCode=96761`: the civilians signed up in one ZIP, as `Civilian[]`.
 * Only `EMBER_AGENT_KEY` may read it (403 for operators and other services); with no keys set
 * (local dev) anyone may.
 */
export const CIVILIANS_PATH = '/v1/civilians';

/** How long an operator session lasts before the operator signs in again. */
export const SESSION_DAYS = 7;

export type Operator = { operatorId: string; email: string; name: string; createdAt: string };

export type SignUpRequest = { email: string; name: string; password: string };

export type SignInRequest = { email: string; password: string };

/** Sign-up and sign-in answer this; `token` goes in `Authorization: Bearer`. */
export type OperatorSession = { token: string; operator: Operator; expiresAt: string };

/** `GET ${SESSION_PATH}`. */
export type SessionInfo = Omit<OperatorSession, 'token'>;

export type WatchZone = {
    id: WatchZoneId;
    name: string;
    /** Where it is, in words (e.g. a geocoded place name). */
    region: string | null;
    /** Ring, first point not repeated, at least 3 points. */
    boundary: LatLng[];
    /** Repeat scans this many hours apart; null scans only on demand. */
    scanEveryHours: number | null;
    /** When the next repeat scan starts; null when repeat scans are off. */
    nextScanAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type CreateWatchZoneRequest = Pick<WatchZone, 'name' | 'boundary'> & {
    region?: string | null;
};

/** Setting `scanEveryHours` (1-168) schedules the next scan that far from now; null turns them off. */
export type UpdateWatchZoneRequest = Partial<
    Pick<WatchZone, 'name' | 'boundary' | 'region' | 'scanEveryHours'>
>;

/** What the zone list shows per zone, without loading the zone. */
export type ZoneSummary = {
    /** Edge servers assigned to the zone with a position, and how many edge-manager has online. */
    edgeServers: number;
    onlineEdgeServers: number;
    placements: number;
    drones: number;
    /** Share (0..1) of the zone within a deployed edge server's connectivity radius. */
    coverage: number;
    lastScan: Scan | null;
    /** Risk zones from the latest scan's detections (see `RiskZonesView`). */
    riskZones: { onFire: number; atRisk: number; onFireM2: number; atRiskM2: number };
    /** When the latest successful plan finished. */
    lastPlanAt: string | null;
};

/** `GET ${ZONE_SUMMARIES_PATH}`, newest zone first. */
export type WatchZoneSummary = WatchZone & { summary: ZoneSummary };

/** What edge-manager's live registry says about an edge server. */
export type EdgeServerLive = Omit<EdgeServerStatus, 'edgeServerId' | 'url'>;

/** A registered edge server. `edgeServerId` is its connector's token, `url` where edge-manager reaches it. */
export type EdgeServer = {
    edgeServerId: string;
    url: string;
    /** Set by the operator, usually from the placement it was assigned to. */
    name: string | null;
    zoneId: WatchZoneId | null;
    /** Ground position; with `connectivityRadiusM`, what a start task needs. */
    location: LatLng | null;
    connectivityRadiusM: number | null;
    /** Null when edge-manager is unreachable or has not seen it since it started. */
    live: EdgeServerLive | null;
    createdAt: string;
    updatedAt: string;
};

/**
 * `PUT /v1/edge-servers/:edgeServerId` creates or updates; edge-manager calls it when a connector
 * registers. Omitted fields keep their value, so a registration (`url` alone) never clears what an
 * operator set; null clears.
 */
export type PutEdgeServerRequest = {
    url: string;
    zoneId?: WatchZoneId | null;
    location?: LatLng | null;
    connectivityRadiusM?: number | null;
};

/** `PATCH /v1/edge-servers/:edgeServerId`: the operator's fields. Omitted fields keep their value. */
export type UpdateEdgeServerRequest = {
    name?: string | null;
    zoneId?: WatchZoneId | null;
    location?: LatLng | null;
    connectivityRadiusM?: number | null;
};

/**
 * A planned edge server site: where a crew should install one. It becomes an edge server when the
 * operator assigns a registered connector to it (`POST /v1/placements/:placementId/assign`), which
 * gives that edge server the placement's zone, name, location and radius and deletes the placement.
 */
export type EdgeServerPlacement = {
    placementId: string;
    zoneId: WatchZoneId;
    name: string;
    location: LatLng;
    connectivityRadiusM: number;
    createdAt: string;
    updatedAt: string;
};

/** `POST ${ZONE_PLACEMENTS_PATH}`: pinpoint one site by hand. */
export type CreatePlacementRequest = {
    location: LatLng;
    connectivityRadiusM?: number;
    name?: string;
};

/**
 * `POST ${ZONE_PLACEMENTS_PATH}/suggest`: replaces the zone's placements with the fewest sites that
 * lift coverage, together with the deployed edge servers, to `targetCoverage`.
 */
export type SuggestPlacementsRequest = {
    /** 0..1. Default 0.92. */
    targetCoverage?: number;
    /** Default 500. */
    connectivityRadiusM?: number;
};

export type SuggestPlacementsResult = {
    placements: EdgeServerPlacement[];
    /** Coverage of the deployed edge servers alone, and with the placements. */
    coverage: number;
    projectedCoverage: number;
};

/** `PATCH /v1/placements/:placementId`. */
export type UpdatePlacementRequest = {
    name?: string;
    location?: LatLng;
    connectivityRadiusM?: number;
};

/** `POST /v1/placements/:placementId/assign`; answers the updated `EdgeServer`. */
export type AssignPlacementRequest = { edgeServerId: string };

/** A registered drone and the edge server it is assigned to. Name and kind come from its `hello`. */
export type Drone = {
    droneId: string;
    edgeServerId: string | null;
    name: string | null;
    kind: DroneKind | null;
    createdAt: string;
    updatedAt: string;
};

/** Omitted `name` and `kind` keep their value. */
export type PutDroneRequest = {
    edgeServerId: string | null;
    name?: string | null;
    kind?: DroneKind | null;
};

/**
 * A zone's mapping run, one run id across its edge servers. `starting` until edge-manager answers;
 * `done` once every edge server that took it reports `done`.
 */
export type ScanState = 'starting' | 'mapping' | 'stopping' | 'done' | 'failed';

export type Scan = {
    runId: string;
    zoneId: WatchZoneId;
    /** Operator id, or `schedule`. */
    requestedBy: string;
    state: ScanState;
    startedAt: string;
    endedAt: string | null;
    cellSizeM: number;
    /** edge-manager's answer, one per edge server; empty while `starting`. */
    results: EdgeServerTaskResult[];
    /** Mean of the coverage (0..1) its edge servers report. */
    coverage: number;
    /** Why it failed, or which edge servers refused it. */
    error: string | null;
    updatedAt: string;
};

/**
 * `POST ${ZONE_SCANS_PATH}` sends a `StartMappingTask` for every edge server of the zone with a
 * position. 409 when one is running or none has a position; 503 without edge-manager.
 * `POST ${ZONE_SCANS_PATH}/:runId/stop` sends the stop.
 */
export type StartScanRequest = { cellSizeM?: number };

/**
 * One edge server's share of a mapping run: `PUT /v1/mapping-runs/:runId/edge-servers/:edgeServerId`
 * takes the connector's `EdgeRun` and adds its `newCells` to `cells`.
 */
export type MappingRun = {
    runId: string;
    edgeServerId: string;
    zoneId: WatchZoneId;
    state: EdgeRunState;
    startedAt: string;
    edgeServer: LatLng;
    connectivityRadiusM: number;
    cellSizeM: number;
    coverage: number;
    /** Every cell mapped so far, ascending, on the grid `MappingMission` defines. */
    cells: number[];
    updatedAt: string;
};

export type PutMappingRunRequest = EdgeRun;

/**
 * `POST /v1/detections`. Frames already stored (same drone, `frameId` and `capturedAt`) are
 * skipped. A frame belongs to the zone of `edgeServerId` when given, else of the drone's edge server.
 */
export type DetectionsIngest = { edgeServerId?: string; frames: DroneDetections[] };

export type DetectionsIngestResult = { accepted: number; duplicates: number };

/** A stored detections frame. `id` is the api's; `frameId` the drone's. */
export type DetectionFrame = DroneDetections & {
    id: string;
    zoneId: WatchZoneId | null;
    edgeServerId: string | null;
    receivedAt: string;
};

/** Detections of the same class that touch on the ground, merged into one area. */
export type RiskZone = PlannerRiskZone & {
    bbox: { south: number; west: number; north: number; east: number };
    center: LatLng;
    areaM2: number;
    firstSeenAt: string;
    /** How many detections were merged into it, and which drones made them. */
    detections: number;
    droneIds: string[];
};

/**
 * `GET ${ZONE_RISK_ZONES_PATH}`: the zone's detections since `since` (the latest scan's start, or
 * the last 7 days without a scan), merged. Also the planner context's `riskZones`.
 */
export type RiskZonesView = {
    zoneId: WatchZoneId;
    since: string;
    generatedAt: string;
    riskZones: RiskZone[];
};

export type SurroundingsStatus = 'pending' | 'ready' | 'failed';

/**
 * Who and what is around a zone, from OpenStreetMap: fetched when the zone is created or its
 * boundary changes, and handed to the planner. `GET ${ZONE_SURROUNDINGS_PATH}?roads=false` leaves
 * `roads` empty; `POST ${ZONE_SURROUNDINGS_PATH}/refresh` fetches again (202).
 */
export type ZoneSurroundings = {
    zoneId: WatchZoneId;
    status: SurroundingsStatus;
    source: string;
    fetchedAt: string | null;
    error: string | null;
    civilianAreas: CivilianArea[];
    roads: Road[];
    safeZones: SafeZone[];
    stations: ResponderStation[];
};

/** `GET ${ZONE_WEATHER_PATH}`: current conditions at the zone; null when unavailable. */
export type ZoneWeather = { weather: Weather | null };

/**
 * `POST ${FOREST_FIT_PATH}`: the vegetated land (OpenStreetMap forest, wood, scrub, grassland and
 * similar) the drawn outline sits on, as one outline. 404 when the outline holds no vegetation,
 * 502 when the map data cannot be fetched.
 */
export type ForestFitRequest = { boundary: LatLng[] };

export type ForestFitResult = {
    boundary: LatLng[];
    areaM2: number;
    /** Share (0..1) of the drawn outline that is vegetated. */
    vegetatedShare: number;
    /** OpenStreetMap tags found, e.g. `natural=wood`. */
    classes: string[];
    source: string;
};

/** `POST /v1/watch-zones/:zoneId/planner-jobs`: stores the job and queues a `PlannerJobRequest`. */
export type CreatePlannerJobRequest = {
    /** Defaults to the signed-in operator's id. */
    requestedBy?: string;
    options?: PlannerOptions;
};

export type PlannerJob = {
    jobId: string;
    zoneId: WatchZoneId;
    state: PlannerJobState;
    requestedBy: string;
    requestedAt: string;
    options: PlannerOptions | null;
    /** Error when `failed`, else the latest progress note. */
    message: string | null;
    /** Only on `GET /v1/planner/jobs/:jobId`, once `succeeded`. */
    result?: PlannerResult | null;
    updatedAt: string;
};

export type BlastAudience = 'civilians' | 'responders' | 'both';
export type BlastPriority = 'routine' | 'urgent' | 'critical';
/** `near_fire`: only those near a risk zone that is on fire. */
export type BlastArea = 'zone' | 'near_fire';

/**
 * A blast that reaches civilians waits in `pending_approval` until an operator approves it; only
 * `queued` blasts are for delivery. Responder-only blasts are queued at once.
 */
export type BlastState = 'pending_approval' | 'queued';

export type BlastApproval = { approvedBy: string; approverName: string; approvedAt: string };

/**
 * `POST ${ZONE_BLASTS_PATH}`. `approve: true` from a signed-in operator approves it in the same
 * call; from anyone else a civilian blast stays `pending_approval`.
 * `POST ${BLASTS_PATH}/:blastId/approve` approves one (operators only).
 */
export type CreateBlastRequest = {
    audience: BlastAudience;
    priority: BlastPriority;
    area: BlastArea;
    title: string;
    body: string;
    approve?: boolean;
};

export type Blast = {
    blastId: string;
    zoneId: WatchZoneId;
    audience: BlastAudience;
    priority: BlastPriority;
    area: BlastArea;
    title: string;
    body: string;
    state: BlastState;
    /** Operator id, or the service that drafted it. */
    createdBy: string;
    createdAt: string;
    approval: BlastApproval | null;
};
