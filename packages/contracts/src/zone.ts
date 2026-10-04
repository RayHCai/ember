import type { LatLng, WatchZoneId } from './common.js';
import type { DroneDetections } from './droneInfo.js';
import type { EdgeServerSite, EdgeServerStatus, EdgeServerTaskResult } from './edge.js';
import type {
    CivilianArea,
    PlannerDetection,
    PlannerRiskZone,
    ResponderStation,
    Road,
    RoadState,
    SafeZone,
    TerrainGrid,
    Weather,
} from './planner.js';

/**
 * Watch zone plane: what api serves the dashboard and operator-agent about one zone.
 * Paths use Fastify parameter syntax.
 */
export const WATCH_ZONES_PATH = '/v1/watch-zones';
export const WATCH_ZONE_PATH = '/v1/watch-zones/:zoneId';
export const ZONE_GEOGRAPHY_PATH = '/v1/watch-zones/:zoneId/geography';
export const ZONE_WEATHER_PATH = '/v1/watch-zones/:zoneId/weather';
export const ZONE_ROADS_PATH = '/v1/watch-zones/:zoneId/roads';
export const ZONE_ROAD_OBSERVATIONS_PATH = '/v1/watch-zones/:zoneId/road-observations';
export const ZONE_RISK_ZONES_PATH = '/v1/watch-zones/:zoneId/risk-zones';
export const RISK_ZONE_PATH = '/v1/watch-zones/:zoneId/risk-zones/:riskZoneId';
export const ZONE_DETECTIONS_PATH = '/v1/watch-zones/:zoneId/detections';
export const ZONE_SIMULATED_DETECTIONS_PATH = '/v1/watch-zones/:zoneId/detections/simulated';
export const DETECTION_PATH = '/v1/detections/:detectionId';
/** drone-info -> api: each `DroneDetections` frame, filed under the zone containing it. */
export const DETECTIONS_INGEST_PATH = '/v1/detections';
export const ZONE_EDGE_SERVERS_PATH = '/v1/watch-zones/:zoneId/edge-servers';
export const ZONE_SCANS_PATH = '/v1/watch-zones/:zoneId/scans';
export const SCAN_STOP_PATH = '/v1/scans/:runId/stop';
export const ZONE_SURVEILLANCE_PATH = '/v1/watch-zones/:zoneId/surveillance';

/**
 * How the surveillance cadence was last set. operator-agent chooses it from risk and weather and
 * starts the scans; the api only records it so every viewer sees the same plan.
 */
export type SurveillancePlan = {
    /** Null: no recurring scans. */
    intervalMin: number | null;
    /** Sector ids or descriptions, highest priority first. */
    priorities: string[];
    reason: string;
    setBy: string;
    setAt: string;
};

export type WatchZone = {
    id: WatchZoneId;
    name: string;
    boundary: LatLng[];
    center: LatLng;
    areaHa: number;
    surveillance: SurveillancePlan | null;
    createdAt: string;
    updatedAt: string;
};

/** Either a drawn `boundary`, or a `center` and `radiusM` the api turns into a 32-sided ring. */
export type CreateWatchZoneRequest = {
    name: string;
    boundary?: LatLng[];
    center?: LatLng;
    radiusM?: number;
};

/** Everything around a zone that changes rarely; replaced as a whole. Road states default `open`. */
export type ZoneGeography = {
    terrain: TerrainGrid | null;
    roads: (Omit<Road, 'state'> & { state?: RoadState })[];
    civilianAreas: CivilianArea[];
    safeZones: SafeZone[];
    stations: ResponderStation[];
};

export type ZoneWeather = { zoneId: WatchZoneId; weather: Weather | null; fetchedAt: string };

export type RoadObservationSource = 'responder' | 'civilian' | 'operator' | 'drone';

/**
 * Names a road by `roadId`, or by `roadName`, matched within the zone ignoring case, punctuation and
 * abbreviations (`Road` is `Rd`); a name contained in a longer one matches it. Answered with 201 and
 * one `RoadObservation` per road segment of that name.
 */
export type RoadObservationRequest = {
    roadId?: string;
    roadName?: string;
    state: RoadState;
    source: RoadObservationSource;
    /** `responder:<id>`, `civilian:<id>`, an operator name, or `ember`. */
    reportedBy: string;
    note: string | null;
    location: LatLng | null;
};

export type RoadObservation = {
    id: string;
    zoneId: WatchZoneId;
    roadId: string;
    roadName: string | null;
    state: RoadState;
    previousState: RoadState;
    source: RoadObservationSource;
    reportedBy: string;
    note: string | null;
    location: LatLng | null;
    observedAt: string;
};

/** 404 / 409 body when `roadName` matches no road or several. */
export type RoadMatchError = { error: string; candidates: { id: string; name: string | null }[] };

export type DetectionSource = 'drone' | 'simulated' | 'civilian_report' | 'satellite';

export type DetectionVerification = 'unverified' | 'verifying' | 'confirmed' | 'dismissed';

export type DetectionRecord = PlannerDetection & {
    zoneId: WatchZoneId;
    source: DetectionSource;
    receivedAt: string;
    verification: DetectionVerification;
};

/** api's answer to a forwarded `DroneDetections` frame. Detections outside every zone are dropped. */
export type DetectionsIngestResult = { accepted: number; dropped: number };

export type DetectionsIngest = DroneDetections;

/** A simulation-only fire: recorded with source `simulated` and drone `simulation`. */
export type SimulatedDetectionRequest = {
    center: LatLng;
    radiusM: number;
    risk: PlannerDetection['risk'];
    confidence: number;
    requestedBy: string;
};

/** Confirming a detection files it as a risk zone; dismissing it keeps it out of plans. */
export type DetectionVerificationRequest = { verification: DetectionVerification; by: string };

export type RiskZoneRecord = PlannerRiskZone & {
    zoneId: WatchZoneId;
    source: 'detection' | 'operator';
    detectionIds: string[];
};

export type CreateRiskZoneRequest = Pick<
    PlannerRiskZone,
    'risk' | 'polygon' | 'confidence' | 'observedAt'
>;

/** An edge server the api knows for a zone, with edge-manager's live view when it answered. */
export type EdgeServerRecord = EdgeServerSite & {
    zoneId: WatchZoneId;
    name: string;
    /** Null when edge-manager is unreachable or the connector has not registered. */
    live: EdgeServerStatus | null;
};

export type RegisterEdgeServerRequest = EdgeServerSite & { name: string };

export type ScanPurpose = 'surveillance' | 'verification';

export type ScanState = 'mapping' | 'stopped' | 'failed';

/** One mapping run across a zone's edge servers. `runId` is the run id sent to edge-manager. */
export type Scan = {
    runId: string;
    zoneId: WatchZoneId;
    purpose: ScanPurpose;
    state: ScanState;
    /** Verification scans map a circle around this point instead of the whole zone. */
    focus: { center: LatLng; radiusM: number } | null;
    reason: string;
    requestedBy: string;
    edgeServerIds: string[];
    results: EdgeServerTaskResult[];
    error: string | null;
    startedAt: string;
    stoppedAt: string | null;
};

/**
 * Without `edgeServerIds` the api uses every edge server of the zone, or for a focused scan those
 * whose connectivity radius reaches the focus.
 */
export type StartScanRequest = {
    purpose: ScanPurpose;
    reason: string;
    requestedBy: string;
    focus?: { center: LatLng; radiusM: number };
    edgeServerIds?: string[];
};

export type StopScanRequest = { requestedBy: string; reason: string };
