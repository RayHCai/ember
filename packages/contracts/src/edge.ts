import type { LatLng, WatchZoneId } from './common.js';
import type { DroneDetections, DroneTelemetry } from './droneInfo.js';
import type { DroneHello, MappingMission, MissionStatus } from './droneLink.js';

/**
 * Edge plane: api -> edge-manager -> N edge-connectors -> drones, and back up.
 *
 * - api calls edge-manager over HTTP: `POST ${EDGE_TASK_PATH}` with an `EdgeTask`,
 *   `GET ${EDGE_SERVERS_PATH}` for the live registry.
 * - edge-manager calls each connector over HTTP: `POST <url>${EDGE_TASK_PATH}` with a
 *   `ConnectorTask`.
 * - Each connector holds one WebSocket to edge-manager at `${EDGE_UPLINK_PATH}`: `register` first,
 *   then `update`s. edge-manager forwards what is new in each to drone-info as a `DroneInfoIngest`
 *   (`droneInfo.ts`): hellos, telemetry that changed, detections.
 *
 * Manager and connectors authenticate each other with `Authorization: Bearer <EMBER_EDGE_KEY>`.
 */
export const EDGE_TASK_PATH = '/v1/tasks';
export const EDGE_SERVERS_PATH = '/v1/edge-servers';
export const EDGE_UPLINK_PATH = '/v1/edge';

/** How to reach one edge server's connector. `edgeServerId` is the connector's token. */
export type EdgeServerLink = { edgeServerId: string; url: string };

/** An edge server of the zone, with what its drones need to map around it. */
export type EdgeServerSite = EdgeServerLink & { location: LatLng; connectivityRadiusM: number };

/** api -> edge-manager. One run id across every edge server of the zone. */
export type StartMappingTask = {
    kind: 'start_mapping';
    runId: string;
    zoneId: WatchZoneId;
    boundary: LatLng[] | null;
    cellSizeM: number;
    altitude: { minM: number; maxM: number };
    edgeServers: EdgeServerSite[];
};

export type StopMappingTask = {
    kind: 'stop_mapping';
    runId: string;
    zoneId: WatchZoneId;
    edgeServers: EdgeServerLink[];
};

export type EdgeTask = StartMappingTask | StopMappingTask;

/** One edge server's outcome; a failed connector does not fail the others. */
export type EdgeServerTaskResult =
    | { edgeServerId: string; ok: true; drones: string[] }
    | { edgeServerId: string; ok: false; error: string };

/** edge-manager's answer to an `EdgeTask`. */
export type EdgeTaskResult = { runId: string; results: EdgeServerTaskResult[] };

/** edge-manager -> one connector. The connector adds `swarm`: every drone connected to it. */
export type ConnectorTask =
    | { kind: 'start_mapping'; mission: Omit<MappingMission, 'swarm'> }
    | { kind: 'stop_mapping'; runId: string };

/** The connector's answer: the drones of the run. Failures are `{ error }` with a 4xx status. */
export type ConnectorTaskResult = { runId: string; drones: string[] };

/** Connector -> manager, first frame on every (re)connect. Registers or refreshes the connector. */
export type EdgeRegister = { type: 'register'; edgeServerId: string; url: string };

/** Manager -> connector, answer to `register`. */
export type EdgeRegistered = { type: 'registered'; serverTime: string };

/** One paired drone as its connector last saw it. */
export type EdgeDrone = {
    droneId: string;
    /** The drone's latest `hello`: name, kind, camera, sensors. */
    hello: DroneHello;
    connected: boolean;
    lastSeen: string;
    /** Latest by `sentAt`; null until the drone reports. */
    telemetry: DroneTelemetry | null;
    /** Latest for the current run; null outside one. */
    status: MissionStatus | null;
};

export type EdgeRunState = 'mapping' | 'stopping' | 'done';

/** The connector's current or last run. Cell indices follow the grid `MappingMission` defines. */
export type EdgeRun = {
    runId: string;
    zoneId: string;
    state: EdgeRunState;
    startedAt: string;
    swarm: string[];
    edgeServer: LatLng;
    connectivityRadiusM: number;
    cellSizeM: number;
    /** Share (0..1) of the run's area mapped, the highest any drone of the swarm reports. */
    coverage: number;
    /** Cells first mapped since the previous update. */
    newCells: number[];
};

/**
 * Connector -> manager about 20 times a second. `drones` and `run` are a snapshot; `detections` and `run.newCells` are only what is new since the
 * previous update, each detections frame sent once.
 */
export type EdgeUpdate = {
    type: 'update';
    edgeServerId: string;
    /** Increases by one per update from this connector; restarts at 1 with the connector. */
    seq: number;
    sentAt: string;
    drones: EdgeDrone[];
    run: EdgeRun | null;
    detections: DroneDetections[];
};

export type EdgeUplink = EdgeRegister | EdgeUpdate;

/** One connector in edge-manager's live registry. */
export type EdgeServerStatus = {
    edgeServerId: string;
    url: string;
    online: boolean;
    connectedAt: string;
    lastSeen: string;
    /** From the connector's latest update. */
    drones: number;
    connectedDrones: number;
    run: { runId: string; state: EdgeRunState } | null;
};
