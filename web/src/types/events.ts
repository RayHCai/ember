// Event contract between server and web (CLAUDE.md, "Events").

export type LatLon = [number, number];

/** Items stored outside their event keep the zone they came from. */
export type Zoned<T> = T & { zone_id: string };

export interface EmberEvent<K extends string = string, P = unknown> {
  kind: K;
  zone_id: string;
  ts: string;
  payload: P;
}

export interface Zone {
  id: string;
  name: string;
  polygon: LatLon[];
  area_km2: number;
}

export type EdgeServerStatus = "pending" | "deployed";

export interface EdgeServer {
  id: string;
  lat: number;
  lon: number;
  radius_m: number;
  status: EdgeServerStatus;
  /** Within reach of a road for maintenance. Missing for operator-placed servers. */
  near_road?: boolean;
}

export interface Road {
  id: string;
  kind: string;
  name: string | null;
  points: LatLon[];
}

export interface Community {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: string;
  population: number | null;
}

export interface Shelter {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: string;
}

/** The zone grid: equal lat/lon steps from the south-west corner, row-major. */
export interface GridInfo {
  south: number;
  west: number;
  north: number;
  east: number;
  dlat: number;
  dlon: number;
  rows: number;
  cols: number;
  cell_m: number;
  /** One "0" or "1" per cell. */
  in_zone: string;
}

export interface ZoneMap {
  /** "osm" (fresh), "cache", or "synthetic" (fallback road grid, SIM). */
  source: "osm" | "cache" | "synthetic";
  note: string | null;
  roads: Road[];
  communities: Community[];
  shelters: Shelter[];
  grid: GridInfo;
  elevation: "terrain" | "flat";
}

export interface EdgePlan {
  servers: EdgeServer[];
  coverage_pct: number;
}

export type DroneState =
  | "docked"
  | "charging"
  | "transit"
  | "surveying"
  | "verifying"
  | "returning"
  | "suppressing";

export interface DroneSortie {
  id: string;
  /** This drone's sortie number in the current survey, from 1. */
  number: number;
  total: number;
  progress_pct: number;
}

export interface Drone {
  id: string;
  lat: number;
  lon: number;
  /** Height above ground. */
  alt_m: number;
  heading_deg: number;
  battery_pct: number;
  state: DroneState;
  dock_id: string;
  sortie?: DroneSortie | null;
  simulated?: boolean;
  zone_id?: string;
}

export type SurveyStatus = "scheduled" | "running" | "complete";

export interface Survey {
  id: string | null;
  status: SurveyStatus;
  progress_pct: number;
  next_at: string | null;
  started_at?: string;
  /** Share of all zone cells observed so far. */
  observed_pct?: number;
  missed_count?: number;
  eta_at?: string | null;
  /** True when this describes the last finished survey. */
  last_completed?: boolean;
}

export interface SurveyCells {
  survey_id: string;
  cells: number[];
  reset?: boolean;
}

export interface Capture {
  id: string;
  survey_id: string | null;
  lat: number;
  lon: number;
  image_url: string | null;
  kind: "rgb" | "thermal";
  simulated: boolean;
}

export interface ReportCell {
  lat: number;
  lon: number;
  score: number;
}

export interface ReportSite {
  id: string;
  rank: number;
  lat: number;
  lon: number;
  area_ha: number;
  peak_score: number;
  drivers: string[];
  nearest_community: string | null;
  community_distance_km: number | null;
  action: string;
  trend: "new" | "up" | "down" | "same";
  capture_id: string | null;
}

export interface ReportTrend {
  avg_score_change: number | null;
  new_sites: number;
  dropped_sites: number;
}

export interface Report {
  id: string;
  survey_id: string;
  created_at: string;
  summary: string;
  mode: "asi1" | "template";
  cells: ReportCell[];
  sites: ReportSite[];
  trend: ReportTrend;
}

export type IncidentStatus = "suspected" | "confirmed" | "dismissed" | "contained";

export interface Incident {
  id: string;
  lat: number;
  lon: number;
  status: IncidentStatus;
  confidence: number;
}

export type Tier = "evacuate" | "prepare" | "watch";

export interface Notification {
  id: string;
  tier: Tier;
  recipients_count: number;
  text: string;
  audio_url: string | null;
  approved_by: string | null;
  incident_id?: string;
  /** The evacuation route and shelter in the message, for evacuate alerts. */
  route_id?: string | null;
  shelter?: string | null;
}

export interface Suppression {
  incident_id: string;
  sorties_done: number;
  sorties_planned: number;
  containment_pct: number;
  treated_cells: LatLon[];
  simulated: true;
}

// --- Agent events -----------------------------------------------------------
// The fire and alert logic runs on a separate service. These are the fields
// the console reads; the service must send them (see CLAUDE.md, "Events").

export type AgentMode = "asi1" | "fallback" | "policy";

/** An agent run began. Its log steps and decision carry the same run_id. */
export interface AgentRun {
  run_id: string;
  trigger: string;
  mode: AgentMode;
}

export interface AgentLog {
  message: string;
  level?: "info" | "warn";
  source?: string;
  run_id?: string;
  /** Tool the agent called in this step, if any. */
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export interface Decision {
  run_id?: string;
  summary: string;
  actions?: string[];
  /** Set when the decision resolves a pending approval. */
  approval_id?: string;
}

export interface Spread {
  incident_id: string;
  cell_m: number;
  /** [lat, lon, minutes until the fire arrives]. */
  cells: [number, number, number][];
  head_bearing_deg: number;
  horizon_min: number;
  communities: { name: string; lat: number; lon: number; arrival_min: number | null }[];
  /** True when this prediction includes suppression. */
  with_suppression?: boolean;
}

export interface Route {
  id: string;
  incident_id: string;
  community: string;
  shelter: string;
  path: LatLon[];
  distance_km: number;
  eta_min: number;
}

export interface ApprovalRequest {
  id: string;
  reason: string;
  tier?: Tier;
  texts: string[];
  recipients_count?: number;
  incident_id?: string;
}

export interface Dispatch {
  message: string;
  incident_id?: string;
  drone_ids?: string[];
}

export interface Resident {
  id: string;
  lat: number;
  lon: number;
  tier: Tier | null;
  community: string;
}

export interface Recipients {
  incident_id: string;
  residents: Resident[];
  simulated: true;
}

export type AgentPayload = Record<string, unknown>;

export interface SimClockState {
  sim_time: string;
  speed: number;
  paused: boolean;
}

export interface Snapshot {
  sim: SimClockState;
  zones: Zone[];
  zone_maps: Record<string, ZoneMap>;
  survey_cells: Record<string, { survey_id: string; cells: number[] }>;
  edge_plans: Record<string, EdgePlan>;
  drones: Drone[];
  surveys: Record<string, Survey>;
  reports: Record<string, Report>;
  captures: Zoned<Capture>[];
  incidents: Zoned<Incident>[];
  approvals: EmberEvent<"approval_request", ApprovalRequest>[];
  notifications: Zoned<Notification>[];
  suppression: Zoned<Suppression>[];
  log: EmberEvent[];
  spread?: Record<string, Spread>;
  routes?: Record<string, Route[]>;
  recipients?: Record<string, Recipients>;
}

export type KnownEvent =
  | EmberEvent<"snapshot", Snapshot>
  | EmberEvent<"sim", SimClockState>
  | EmberEvent<"zone", Zone>
  | EmberEvent<"zone_map", ZoneMap>
  | EmberEvent<"zone_removed", { id: string }>
  | EmberEvent<"edge_plan", EdgePlan>
  | EmberEvent<"drone", Drone>
  | EmberEvent<"fleet", { drones: Drone[] }>
  | EmberEvent<"survey_cells", SurveyCells>
  | EmberEvent<"survey", Survey>
  | EmberEvent<"capture", Capture>
  | EmberEvent<"report", Report>
  | EmberEvent<"incident", Incident>
  | EmberEvent<"notification", Notification>
  | EmberEvent<"suppression", Suppression>
  | EmberEvent<"agent_run", AgentRun>
  | EmberEvent<"log", AgentLog>
  | EmberEvent<"decision", Decision>
  | EmberEvent<"spread", Spread>
  | EmberEvent<"route", Route>
  | EmberEvent<"approval_request", ApprovalRequest>
  | EmberEvent<"dispatch", Dispatch>
  | EmberEvent<"alert", AgentLog>
  | EmberEvent<"recipients", Recipients>;
