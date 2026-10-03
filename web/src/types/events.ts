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

export interface Drone {
  id: string;
  lat: number;
  lon: number;
  alt_m: number;
  heading_deg: number;
  battery_pct: number;
  state: DroneState;
  dock_id: string;
}

export type SurveyStatus = "scheduled" | "running" | "complete";

export interface Survey {
  id: string;
  status: SurveyStatus;
  progress_pct: number;
  next_at: string | null;
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
}

export interface Suppression {
  incident_id: string;
  sorties_done: number;
  sorties_planned: number;
  containment_pct: number;
  treated_cells: LatLon[];
  simulated: true;
}

// Payloads emitted by the existing agent. Kept loose until they are matched
// to agent/ember (see agent/README.md).
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
  edge_plans: Record<string, EdgePlan>;
  drones: Drone[];
  surveys: Record<string, Survey>;
  reports: Record<string, Report>;
  captures: Zoned<Capture>[];
  incidents: Zoned<Incident>[];
  approvals: EmberEvent[];
  notifications: Zoned<Notification>[];
  suppression: Zoned<Suppression>[];
  log: EmberEvent[];
}

export type KnownEvent =
  | EmberEvent<"snapshot", Snapshot>
  | EmberEvent<"sim", SimClockState>
  | EmberEvent<"zone", Zone>
  | EmberEvent<"zone_map", ZoneMap>
  | EmberEvent<"zone_removed", { id: string }>
  | EmberEvent<"edge_plan", EdgePlan>
  | EmberEvent<"drone", Drone>
  | EmberEvent<"survey", Survey>
  | EmberEvent<"capture", Capture>
  | EmberEvent<"report", Report>
  | EmberEvent<"incident", Incident>
  | EmberEvent<"notification", Notification>
  | EmberEvent<"suppression", Suppression>
  | EmberEvent<
      "log" | "spread" | "route" | "dispatch" | "alert" | "approval_request" | "decision",
      AgentPayload
    >;
