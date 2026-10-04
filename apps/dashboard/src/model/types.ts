import type {
    Blast,
    Drone,
    DroneKind,
    EdgeServer,
    EdgeServerPlacement,
    MappingRun,
    PlannerJob,
    PlannerResult,
    RiskZone,
    RiskZonesView,
    Scan,
    Weather,
    WatchZone,
    ZoneSurroundings,
} from '@ember/contracts';

// The dashboard's view of a watch zone, built from the api's records (`ZoneRecords`).

export type LatLon = [number, number];

/** Equal lat/lon steps from the south-west corner, row-major. */
export interface Grid {
    south: number;
    west: number;
    north: number;
    east: number;
    dlat: number;
    dlon: number;
    rows: number;
    cols: number;
    cellM: number;
    /** One entry per cell: 1 inside the boundary. */
    inZone: Uint8Array;
    inZoneCount: number;
}

/** A deployed edge server or a planned placement, as the map draws it. */
export interface ServerView {
    id: string;
    name: string;
    lat: number;
    lon: number;
    radiusM: number;
    status: 'pending' | 'deployed';
    /** Deployed: whether edge-manager has its uplink open; null when unknown. */
    online: boolean | null;
    edge: EdgeServer | null;
    placement: EdgeServerPlacement | null;
}

export interface DroneView {
    id: string;
    name: string;
    serverId: string | null;
    kind: DroneKind | null;
    registeredAt: number;
}

export interface Schedule {
    enabled: boolean;
    everyHours: number;
    nextAt: number | null;
}

/** Everything the api holds about one zone, as last fetched. */
export interface ZoneRecords {
    zone: WatchZone;
    edgeServers: EdgeServer[];
    placements: EdgeServerPlacement[];
    drones: Drone[];
    scans: Scan[];
    runs: MappingRun[];
    riskZones: RiskZonesView | null;
    surroundings: ZoneSurroundings | null;
    /** Newest first, without results. */
    planJobs: PlannerJob[];
    /** The newest succeeded job, with its result. */
    plan: PlannerJob | null;
    blasts: Blast[];
    weather: Weather | null;
}

export interface ZoneView {
    id: string;
    name: string;
    region: string;
    createdAt: number;
    boundary: LatLon[];
    areaKm2: number;
    grid: Grid;
    servers: ServerView[];
    drones: DroneView[];
    schedule: Schedule;
    /** The running scan, if any, and the newest one. */
    scan: Scan | null;
    lastScan: Scan | null;
    lastScanAt: number | null;
    runs: MappingRun[];
    riskZones: RiskZone[];
    surroundings: ZoneSurroundings | null;
    planJob: PlannerJob | null;
    plan: PlannerResult | null;
    planAt: number | null;
    planning: boolean;
    blasts: Blast[];
    weather: Weather | null;
}

export type ZoneStatus = 'setup' | 'awaiting' | 'healthy' | 'at_risk' | 'on_fire';
