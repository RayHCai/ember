import type { LatLng } from './common.js';
import type { CameraSpec, DroneDetections, DroneKind, DroneTelemetry } from './droneInfo.js';

/**
 * Edge link: the WebSocket between one drone-runtime and its edge-connector, JSON text frames at
 * `ws://<edge-connector>${DRONE_LINK_PATH}`. The connector pairs drones, fans mapping runs out to
 * them, relays `swarm` messages to the other drones of the same run and forwards `telemetry` and
 * `detections` up unchanged.
 */
export const DRONE_LINK_PATH = '/v1/drone';

/**
 * DNS-SD service type an edge-connector announces over mDNS on its network, so drones find it
 * without being given its address. TXT records: `id` (edge server id) and `path` (the link path).
 */
export const EDGE_SERVICE_TYPE = '_ember-edge._tcp';

export type DroneSensor = 'rgb' | 'thermal' | 'depth';

/** Drone -> connector, first message on every (re)connect. */
export type DroneHello = {
    type: 'hello';
    droneId: string;
    name: string;
    kind: DroneKind;
    camera: CameraSpec;
    sensors: DroneSensor[];
    maxSpeedMps: number;
    enduranceS: number;
};

/** Connector -> drone, answer to `hello`. */
export type EdgeWelcome = { type: 'welcome'; edgeServerId: string; serverTime: string };

/**
 * One mapping run for the drones of one edge server. The mission frame is metres east, north and up
 * of the edge server's ground position; swarm messages use it so drones never exchange lat/lng.
 *
 * The coverage grid is square, `cols = ceil(2 * connectivityRadiusM / cellSizeM)` cells a side,
 * its south-west corner at `(-cols * cellSizeM / 2, -cols * cellSizeM / 2)`. Cell index is
 * `row * cols + col`, row 0 at the south edge, col 0 at the west edge.
 */
export type MappingMission = {
    runId: string;
    zoneId: string;
    edgeServer: LatLng;
    connectivityRadiusM: number;
    /** Watch zone outline; the area mapped is its intersection with the connectivity disc. */
    boundary: LatLng[] | null;
    cellSizeM: number;
    /** Flight band above the ground. */
    altitude: { minM: number; maxM: number };
    /** Every drone in the run, this one included. */
    swarm: string[];
};

export type StartMapping = { type: 'start_mapping'; mission: MappingMission };

/** Ends the run: drones fly back to where they took off and land. */
export type StopMapping = { type: 'stop_mapping'; runId: string };

export type MissionVec3 = { eastM: number; northM: number; upM: number };

export type MissionPhase = 'takeoff' | 'mapping' | 'returning' | 'landing' | 'landed';

/** Where a drone is and where it is going, about 4 times a second. */
export type SwarmState = {
    kind: 'state';
    sentAt: string;
    phase: MissionPhase;
    position: MissionVec3;
    velocity: MissionVec3;
    goal: { eastM: number; northM: number } | null;
    batteryPct: number;
};

/** Cells this drone observed since its last coverage message, with surface height above ground. */
export type SwarmCoverage = {
    kind: 'coverage';
    cells: number[];
    /** Same length as `cells`; null where the drone has no depth to measure height. */
    topM: (number | null)[];
    /**
     * Log-odds this drone's own frames added to cells' fire evidence since its last coverage
     * message (never evidence relayed from peers, so nothing is counted twice). Receivers add them
     * to their own. `onFire` and `atRisk` are the same length as `cells`.
     */
    evidence?: SwarmEvidence;
};

export type SwarmEvidence = { cells: number[]; onFire: number[]; atRisk: number[] };

export type SwarmPayload = SwarmState | SwarmCoverage;

/** Both directions. The connector overwrites `from` with the sender before relaying. */
export type SwarmEnvelope = { type: 'swarm'; runId: string; from: string; payload: SwarmPayload };

/** Drone -> connector, about once a second during a run. */
export type MissionStatus = {
    type: 'mission_status';
    droneId: string;
    runId: string;
    phase: MissionPhase;
    /** Share (0..1) of the run's area mapped by the whole swarm, as this drone knows it. */
    coverage: number;
    detections: number;
};

export type DroneUplink =
    DroneHello | DroneTelemetry | DroneDetections | MissionStatus | SwarmEnvelope;

export type EdgeDownlink = EdgeWelcome | StartMapping | StopMapping | SwarmEnvelope;
