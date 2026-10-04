import type { LatLng, RiskLevel } from './common.js';
import type { DroneHello } from './droneLink.js';

/**
 * Drone Info live stream: what drone-info sends viewers (dashboard, responder, sim) about the
 * fleet. JSON text frames over WebSocket at `ws://<drone-info>${DRONE_INFO_STREAM_PATH}`.
 * Drones report the same `telemetry` and `detections` shapes upstream (drone-runtime).
 */
export const DRONE_INFO_STREAM_PATH = '/v1/stream';

/** `simulated` drones run headless on a laptop; `physical` drones are hardware (e.g. Raspberry Pi). */
export type DroneKind = 'simulated' | 'physical';

export type DroneMode = 'idle' | 'patrol' | 'returning' | 'landed';

/** Pinhole camera. Ground is flat at the drone's ground level (same model as Demo Data). */
export type CameraSpec = { widthPx: number; heightPx: number; hfovDeg: number };

/**
 * `altM` is height above the ground directly below. `headingDeg` 0 = north, 90 = east.
 * `pitchDeg` -90 looks straight down (image top = heading), 0 = horizon.
 */
export type DronePose = {
    lat: number;
    lng: number;
    altM: number;
    headingDeg: number;
    pitchDeg: number;
};

export type RiskDetection = {
    id: string;
    risk: Exclude<RiskLevel, 'none'>;
    /**
     * Probability the region is at this risk, from evidence the drone accumulated per grid cell
     * across frames and drones. Only regions past the drone's confirm line are reported.
     */
    confidence: number;
    /** [x0, y0, x1, y1] in the camera pixels of the detections message, origin top-left. */
    bboxPx: [number, number, number, number];
    /**
     * The region's outline projected onto the ground, clockwise from its top-left point: the
     * segmented shape when the detector gives one, else the box's four corners.
     */
    ground: LatLng[];
    center: LatLng;
    areaM2: number;
    peakTempK?: number;
};

export type DroneSummary = {
    droneId: string;
    name: string;
    kind: DroneKind;
    mode: DroneMode;
    batteryPct: number;
    pose: DronePose;
    lastSeen: string;
};

/** Every known drone, sent on connect and about once a second. */
export type FleetSnapshot = { type: 'fleet'; drones: DroneSummary[] };

export type DroneTelemetry = {
    type: 'telemetry';
    droneId: string;
    sentAt: string;
    /** Scenario clock (ISO 8601 with offset) the drone's sensors follow; null before the first sync. */
    scenarioTime: string | null;
    /** Scenario seconds per wall-clock second, so a viewer can interpolate between messages. */
    scenarioSpeed: number;
    pose: DronePose;
    camera: CameraSpec;
    velocity: { eastMps: number; northMps: number; upMps: number };
    batteryPct: number;
    mode: DroneMode;
};

/** Risks the drone's model found in one captured frame, georeferenced to the ground. */
export type DroneDetections = {
    type: 'detections';
    droneId: string;
    frameId: number;
    capturedAt: string;
    scenarioTime: string;
    /** Pose and camera the frame was taken with (not the drone's current pose). */
    pose: DronePose;
    camera: CameraSpec;
    detector: string;
    detections: RiskDetection[];
};

export type DroneInfoMessage = FleetSnapshot | DroneTelemetry | DroneDetections;

/** Viewer -> drone-info: stream `telemetry` and `detections` for one drone (null: none). */
export type FollowDrone = { type: 'follow'; droneId: string | null };

/**
 * Edge-manager -> drone-info: what drones reported through their edge, forwarded unchanged and
 * batched. `POST http://<drone-info>${DRONE_INFO_INGEST_PATH}`; drone-info answers
 * `DroneInfoIngestResult`. `hello` gives a drone its name and kind in the fleet.
 */
export const DRONE_INFO_INGEST_PATH = '/v1/ingest';

export type DroneInfoIngest = { messages: (DroneHello | DroneTelemetry | DroneDetections)[] };

/** Messages that did not match the contract are dropped and counted, never fail the batch. */
export type DroneInfoIngestResult = { accepted: number; rejected: number; errors: string[] };
