import type { LatLng, RiskLevel } from './common.js';

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
    confidence: number;
    /** [x0, y0, x1, y1] in the camera pixels of the detections message, origin top-left. */
    bboxPx: [number, number, number, number];
    /** The box outline projected onto the ground, clockwise from the top-left corner. */
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
