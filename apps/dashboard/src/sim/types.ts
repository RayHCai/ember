// The console's view of a watch zone, from built-in dummy data or, for live zones, the Ember api.

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

export type EdgeServerStatus = 'pending' | 'deployed';

export interface EdgeServerHealth {
    cpuPct: number;
    memoryPct: number;
    temperatureC: number;
    latencyMs: number;
    uptimeH: number;
    firmware: string;
    power: 'grid' | 'solar' | 'battery';
}

/** What edge-manager last reported for a live edge server. */
export interface EdgeServerLive {
    online: boolean;
    drones: number;
    connectedDrones: number;
    lastSeenAt: number;
}

export interface EdgeServer {
    id: string;
    name: string;
    lat: number;
    lon: number;
    radiusM: number;
    status: EdgeServerStatus;
    health: EdgeServerHealth;
    /** Live zones only: null when edge-manager has no status for it. */
    live?: EdgeServerLive | null;
}

export type DroneState = 'docked' | 'charging' | 'launching' | 'scanning' | 'returning';

export interface Drone {
    id: string;
    name: string;
    serverId: string;
    model: string;
    firmware: string;
    pairedAt: number;
}

/** Fast-changing drone state, kept outside React (see sim/live.ts). */
export interface DroneTelemetry {
    lat: number;
    lon: number;
    altM: number;
    headingDeg: number;
    speedMs: number;
    batteryPct: number;
    signalPct: number;
    state: DroneState;
    lastSeenAt: number;
}

/** Per cell: 0 not yet mapped, else 1 no risk, 2 at risk, 3 on fire. */
export type CellRisk = 0 | 1 | 2 | 3;

export interface Hazard {
    at: LatLon;
    kind: 'fire' | 'risk';
    radiusM: number;
}

export interface Community {
    id: string;
    name: string;
    lat: number;
    lon: number;
    population: number;
}

export interface SafeZone {
    id: string;
    name: string;
    lat: number;
    lon: number;
}

export interface Schedule {
    enabled: boolean;
    everyHours: number;
    nextAt: number | null;
}

export interface ScanRun {
    id: string;
    startedAt: number;
    endsAt: number;
    progress: number;
}

export interface CivilianImpact {
    communityId: string;
    name: string;
    lat: number;
    lon: number;
    population: number;
    /** Minutes until the fire is predicted to arrive, if it does within the horizon. */
    arrivalMin: number | null;
    /** 1 = reached soonest, 0 = least soon. */
    urgency: number;
}

export interface EvacuationRoute {
    id: string;
    name: string;
    communityId: string;
    safeZoneId: string;
    path: LatLon[];
    distanceKm: number;
    etaMin: number;
    status?: 'clear' | 'tight';
    /** A way out that shares no road with `path`. */
    alternate?: LatLon[] | null;
}

export interface SpreadForecast {
    origin: LatLon;
    headingDeg: number;
    horizonMin: number;
    cellM: number;
    /** [lat, lon, minutes until the fire arrives]. */
    cells: [number, number, number][];
    /** Hurricane-style track: the head's predicted position over time. */
    track: { at: LatLon; atMin: number; radiusM: number }[];
    /** Predicted perimeters, when the planner draws them. */
    isochrones?: { atMin: number; rings: LatLon[][] }[];
}

export interface CivilianPlan {
    generatedAt: number;
    spread: SpreadForecast;
    impacts: CivilianImpact[];
    routes: EvacuationRoute[];
}

export interface DropSite {
    id: string;
    name: string;
    lat: number;
    lon: number;
    radiusM: number;
    purpose: string;
    crews: number;
}

export interface ResponderPlan {
    generatedAt: number;
    spread: SpreadForecast;
    dropSites: DropSite[];
}

export interface CivilianReport {
    id: string;
    from: string;
    text: string;
    lat: number;
    lon: number;
    receivedAt: number;
    status: 'new' | 'verified' | 'dismissed';
}

export interface Responder {
    id: string;
    name: string;
    unit: string;
    device: string;
    joinedAt: number;
}

export type RoadState = 'open' | 'blocked' | 'uncertain';

export interface ZoneRoad {
    id: string;
    name: string | null;
    path: LatLon[];
    state: RoadState;
}

export type BlastAudience = 'civilians' | 'responders' | 'both';
export type BlastPriority = 'routine' | 'urgent' | 'critical';

/** Outbound civilian alerts never leave without one of these. */
export interface ApprovalRecord {
    approvedBy: string;
    approvedAt: number;
}

export interface Blast {
    id: string;
    audience: BlastAudience;
    priority: BlastPriority;
    title: string;
    body: string;
    area: 'zone' | 'near_fire';
    recipients: { civilians: number; responders: number };
    sentAt: number;
    approval: ApprovalRecord | null;
}

export interface WatchZone {
    id: string;
    name: string;
    region: string;
    createdAt: number;
    boundary: LatLon[];
    areaKm2: number;
    grid: Grid;
    servers: EdgeServer[];
    drones: Drone[];
    schedule: Schedule;
    lastScanAt: number | null;
    scan: ScanRun | null;
    /** Per cell, see CellRisk. Mutated in place during scans; `riskVersion` marks changes. */
    risk: Uint8Array;
    riskVersion: number;
    hazards: Hazard[];
    windFromDeg: number;
    communities: Community[];
    safeZones: SafeZone[];
    civilianPlan: CivilianPlan | null;
    responderPlan: ResponderPlan | null;
    planning: { civilian: boolean; responder: boolean };
    checkIns: { safe: number; total: number };
    reports: CivilianReport[];
    responders: Responder[];
    blasts: Blast[];
    /** Sourced from the Ember api (src/live/) rather than the dummy backend. */
    live?: boolean;
    roads?: ZoneRoad[];
}

export type ZoneStatus = 'setup' | 'awaiting' | 'healthy' | 'at_risk' | 'on_fire';
