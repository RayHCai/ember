import type { LatLng, RiskLevel, WatchZoneId } from './common.js';
import type { RiskDetection } from './droneInfo.js';

/**
 * Planner plane: api -> Redis -> planner orchestrator -> Celery worker, and back to api over HTTP.
 *
 * - api LPUSHes a `PlannerJobRequest` (JSON) onto the Redis list `PLANNER_QUEUE_KEY`.
 * - The orchestrator moves it to `PLANNER_PROCESSING_KEY`, reads the zone's `PlannerContext` from
 *   `GET ${PLANNER_CONTEXT_PATH}`, and hands both to a worker on the Celery queue
 *   `PLANNER_CELERY_QUEUE` (task `PLANNER_CELERY_TASK`).
 * - It reports progress to `POST ${PLANNER_STATUS_PATH}` and the worker's `PlannerResult` to
 *   `POST ${PLANNER_RESULT_PATH}`; an accepted result is what marks the job succeeded.
 *
 * Paths use Fastify parameter syntax. The planner authenticates to api with
 * `Authorization: Bearer <EMBER_PLANNER_KEY>`.
 */
export const PLANNER_QUEUE_KEY = 'ember:planner:jobs';
export const PLANNER_PROCESSING_KEY = 'ember:planner:processing';
export const PLANNER_CELERY_QUEUE = 'planner';
export const PLANNER_CELERY_TASK = 'ember_planner.plan';
export const PLANNER_CONTEXT_PATH = '/v1/watch-zones/:zoneId/planner-context';
export const PLANNER_STATUS_PATH = '/v1/planner/jobs/:jobId/status';
export const PLANNER_RESULT_PATH = '/v1/planner/jobs/:jobId/result';

/** Every field is optional; the planner's defaults are in its README. */
export type PlannerOptions = {
    /** How far ahead to forecast spread. Default 180. */
    horizonMin?: number;
    /** Spacing of the forecast isochrones. Default 30. */
    bandMin?: number;
    /** How many attack zones to recommend. Default 5. */
    attackZoneCount?: number;
    /** Time between the plan and civilians starting to move. Default 10. */
    evacuationDelayMin?: number;
    /** Minimum lead an evacuation route keeps over the fire at every point. Default 15. */
    safetyMarginMin?: number;
    /**
     * Paths evacuation routes keep off wherever another way out exists, such as a route reported
     * blocked. Default none.
     */
    avoidPaths?: LatLng[][];
};

/** api -> Redis -> orchestrator. */
export type PlannerJobRequest = {
    jobId: string;
    zoneId: WatchZoneId;
    requestedAt: string;
    /** Operator id, or `schedule` / `detection` for automatic runs. */
    requestedBy: string;
    options?: PlannerOptions;
};

/** `none` is anything that does not carry fire: water, rock, bare ground, pavement. */
export type FuelType = 'none' | 'grass' | 'shrub' | 'timber' | 'urban';

/** Rows run south to north, columns west to east; cell (0, 0) has its south-west corner at `southWest`. */
export type GridSpec = { southWest: LatLng; cellSizeM: number; cols: number; rows: number };

/** Surrounding terrain, row-major per `GridSpec`. Either layer may be missing. */
export type TerrainGrid = GridSpec & {
    elevationM: (number | null)[] | null;
    fuel: FuelType[] | null;
};

export type Weather = {
    observedAt: string;
    windSpeedMps: number;
    /** Meteorological: the direction the wind blows from, degrees clockwise from north. */
    windFromDeg: number;
    temperatureC: number | null;
    relativeHumidityPct: number | null;
};

/** A mapped area the api holds as at risk or on fire, merged from drone runs. */
export type PlannerRiskZone = {
    id: string;
    risk: Exclude<RiskLevel, 'none'>;
    polygon: LatLng[];
    confidence: number;
    observedAt: string;
};

/** One drone detection (bounding box and its ground outline) not yet merged into a risk zone. */
export type PlannerDetection = RiskDetection & { droneId: string; capturedAt: string };

/** Where civilians live or gather. `polygon` is null when only a point is known. */
export type CivilianArea = {
    id: string;
    name: string;
    center: LatLng;
    polygon: LatLng[] | null;
    population: number;
};

export type RoadKind = 'motorway' | 'primary' | 'secondary' | 'residential' | 'track';

export type Road = { id: string; name: string | null; kind: RoadKind; path: LatLng[] };

/** An evacuation destination: shelter, assembly point, or a road exit out of the area. */
export type SafeZone = { id: string; name: string; location: LatLng; capacity: number | null };

/** Where responders deploy from. */
export type ResponderStation = { id: string; name: string; location: LatLng };

/** api -> orchestrator: everything the planner knows about one watch zone and its surroundings. */
export type PlannerContext = {
    zoneId: WatchZoneId;
    name: string;
    boundary: LatLng[];
    generatedAt: string;
    weather: Weather | null;
    terrain: TerrainGrid | null;
    riskZones: PlannerRiskZone[];
    detections: PlannerDetection[];
    civilianAreas: CivilianArea[];
    roads: Road[];
    safeZones: SafeZone[];
    stations: ResponderStation[];
};

/** Orchestrator states. api sets `queued`; an accepted `PlannerResult` sets `succeeded`. */
export type PlannerJobState = 'queued' | 'gathering' | 'planning' | 'succeeded' | 'failed';

/** orchestrator -> api. */
export type PlannerJobStatusUpdate = {
    jobId: string;
    zoneId: WatchZoneId;
    state: Exclude<PlannerJobState, 'queued' | 'succeeded'>;
    at: string;
    /** The error when `failed`; otherwise a short progress note or null. */
    message: string | null;
};

/** A ring, first point not repeated, plus any holes. */
export type PolygonShape = { outer: LatLng[]; holes: LatLng[][] };

/** The predicted fire perimeter `atMin` minutes after the plan. */
export type FireIsochrone = { atMin: number; areaHa: number; polygons: PolygonShape[] };

export type FireSpreadForecast = {
    grid: GridSpec;
    /**
     * Minutes from the plan's `generatedAt` until fire reaches each cell, row-major per `grid`.
     * Negative: burning before the plan. Null: not reached within the horizon.
     */
    arrivalMin: (number | null)[];
    isochrones: FireIsochrone[];
    /** Centre of the burnt area over time: the hurricane-style track. */
    track: { atMin: number; center: LatLng; areaHa: number }[];
    /** Direction the fire moves toward, degrees clockwise from north; null when it does not move. */
    headingDeg: number | null;
    maxSpreadMpm: number;
};

/** A recommended place to fight the fire: drop site plus a working radius. */
export type AttackZone = {
    id: string;
    rank: number;
    center: LatLng;
    radiusM: number;
    /** Where crews leave vehicles: the nearest road point, or the centre when there are no roads. */
    dropSite: LatLng;
    /** 0 to 1, relative to the best zone of this plan. */
    score: number;
    fireArrivalMin: number;
    /** Travel from the nearest station; null when the context has no stations. */
    accessMin: number | null;
    spreadRateMpm: number;
    /** `direct`: work the fire edge. `indirect`: cut line ahead of a fast front. */
    tactic: 'direct' | 'indirect';
    protects: string[];
    protectedPopulation: number;
    protectedAreaHa: number;
};

export type ImpactSeverity = 'immediate' | 'warning' | 'watch' | 'clear';

/** How soon fire reaches one civilian area if nothing is done. */
export type CivilianImpact = {
    civilianAreaId: string;
    name: string;
    population: number;
    /** Null when the fire does not reach the area within the horizon. */
    impactMin: number | null;
    /** 1 is reached soonest (or already burning), 0 is not reached within the horizon. */
    gradient: number;
    /** Share of the area reached within the horizon, 0 to 1. */
    exposedFraction: number;
    severity: ImpactSeverity;
};

export type EvacuationRoute = {
    civilianAreaId: string;
    /** `tight`: the route keeps the safety margin but less than twice it. */
    status: 'clear' | 'tight' | 'no_safe_route';
    /** Empty when there is no safe route. */
    path: LatLng[];
    destination: { safeZoneId: string | null; location: LatLng } | null;
    distanceM: number;
    etaMin: number;
    /** Smallest lead over the fire along the route; null when the fire never reaches it. */
    clearanceMin: number | null;
    /** `roads` when the context had a road network, `terrain` for straight cross-country routing. */
    network: 'roads' | 'terrain';
};

/** worker -> orchestrator -> api. */
export type PlannerResult = {
    jobId: string;
    zoneId: WatchZoneId;
    generatedAt: string;
    contextGeneratedAt: string;
    horizonMin: number;
    /** Defaults the planner fell back on because the context lacked data. */
    assumptions: string[];
    fireSpread: FireSpreadForecast;
    attackZones: AttackZone[];
    civilianImpacts: CivilianImpact[];
    evacuationRoutes: EvacuationRoute[];
};
