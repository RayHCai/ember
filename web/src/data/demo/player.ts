import { cellCenter, computeCoverage, polygonAreaKm2, projector } from "../../geo/grid";
import { simNow, useAppStore, type DemoState } from "../../state/store";
import type {
  AgentMode,
  ApprovalRequest,
  Drone,
  DroneState,
  EdgePlan,
  EdgeServer,
  KnownEvent,
  LatLon,
  Notification,
  Report,
  Shelter,
  Snapshot,
  Spread,
  Survey,
  Tier,
  Zone,
} from "../../types/events";
import {
  alertText,
  demoScenario,
  dockOf,
  dronesOf,
  dummyEdgeLayout,
  headBand,
  insideZone,
  makeReport,
  nearestDock,
  residents,
  routesFor,
  scenarioForZone,
  spreadField,
  type Scenario,
} from "./scenario";

// The console's built-in dummy backend. It answers the operator's actions with
// dummy data and plays the demo story, all as events in the same format a real
// logic service would send, on the console's own sim clock. All data is SIMULATED.

type Emit = (event: KnownEvent) => void;

const MIN = 60_000;
const DEMO_SPEED = 360;
const TELEMETRY_MS = 250;
const STORY = { ready: 0, survey: 1, report: 2, hotspot: 3, confirmed: 4, suppression: 5, contained: 6 } as const;

interface Flight {
  path: LatLon[];
  cumulative: number[];
  startMs: number;
  durationMs: number;
  state: DroneState;
  /** Cells imaged along the way, by distance along the path. */
  cells?: [number, number][];
}

interface Step {
  label: string;
  durationMs: number;
  enter: () => void;
  update?: (elapsedMs: number) => void;
}

function pathLength(path: LatLon[]): number[] {
  const project = projector(path[0]!);
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = project(path[i - 1]!);
    const [x1, y1] = project(path[i]!);
    out.push(out[i - 1]! + Math.hypot(x1 - x0, y1 - y0));
  }
  return out;
}

function pointAt(f: Flight, d: number): { at: LatLon; heading: number } {
  const total = f.cumulative[f.cumulative.length - 1]!;
  const dist = Math.max(0, Math.min(total, d));
  let i = 1;
  while (i < f.cumulative.length - 1 && f.cumulative[i]! < dist) i++;
  const a = f.path[i - 1]!;
  const b = f.path[i]!;
  const seg = f.cumulative[i]! - f.cumulative[i - 1]! || 1;
  const t = (dist - f.cumulative[i - 1]!) / seg;
  const [bx, by] = projector(a)(b);
  return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360 };
}

/** Dummy survey paths: each dock's nearest cells, swept in rows by its two drones. */
function surveyPaths(sc: Scenario): Map<string, { path: LatLon[]; cells: [number, number][] }> {
  const { grid, docks } = sc;
  const project = projector(sc.zone.polygon[0]!);
  const dockXY = docks.map((d) => ({ id: d.id, xy: project([d.lat, d.lon]) }));
  const byDock = new Map<string, number[]>();
  for (const cell of sc.cells) {
    const [x, y] = project(cellCenter(grid, cell));
    const near = dockXY.reduce((b, d) => ((d.xy[0] - x) ** 2 + (d.xy[1] - y) ** 2 < (b.xy[0] - x) ** 2 + (b.xy[1] - y) ** 2 ? d : b));
    byDock.set(near.id, [...(byDock.get(near.id) ?? []), cell]);
  }
  const out = new Map<string, { path: LatLon[]; cells: [number, number][] }>();
  for (const dock of docks) {
    const rows = new Map<number, number[]>();
    for (const cell of byDock.get(dock.id) ?? []) {
      const band = Math.floor(cell / grid.cols / 2); // one pass per two rows
      rows.set(band, [...(rows.get(band) ?? []), cell]);
    }
    const bands = [...rows.keys()].sort((a, b) => a - b);
    [0, 1].forEach((k) => {
      const path: LatLon[] = [[dock.lat, dock.lon]];
      const cells: [number, LatLon][] = [];
      bands
        .filter((_, i) => i % 2 === k)
        .forEach((band, i) => {
          const bandCells = rows.get(band)!;
          const cols = bandCells.map((c) => c % grid.cols);
          const lat = grid.south + (band * 2 + 1) * grid.dlat;
          const west = grid.west + (Math.min(...cols) + 0.5) * grid.dlon;
          const east = grid.west + (Math.max(...cols) + 0.5) * grid.dlon;
          const [from, to] = i % 2 === 0 ? [west, east] : [east, west];
          path.push([lat, from], [lat, to]);
          for (const c of bandCells) cells.push([c, cellCenter(grid, c)]);
        });
      path.push([dock.lat, dock.lon]);
      const cum = pathLength(path);
      const located: [number, number][] = cells.map(([c, p]) => {
        let best = 0;
        let bestD = Infinity;
        const [px, py] = project(p);
        for (let s = 1; s < path.length; s++) {
          const [ax, ay] = project(path[s - 1]!);
          const [bx, by] = project(path[s]!);
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
          if (d < bestD) {
            bestD = d;
            best = cum[s - 1]! + t * Math.sqrt(len2);
          }
        }
        return [best, c];
      });
      out.set(`${dock.id}-d${k + 1}`, { path, cells: located.sort((a, b) => a[0] - b[0]) });
    });
  }
  return out;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "zone";
}

export class DemoPlayer {
  private timer = 0;
  private world = new Map<string, Scenario>();
  private edgePlans = new Map<string, EdgePlan>();
  private sc: Scenario;
  private stepIndex = 0;
  private stopAt: number = STORY.contained;
  private mode: DemoState["mode"] = "story";
  private stepStartMs = 0;
  private lastTelemetry = 0;
  private drones = new Map<string, Drone>();
  private droneZone = new Map<string, string>();
  private flights = new Map<string, Flight>();
  private observed = new Set<number>();
  private surveyId = "";
  private report: Report | null = null;
  private fire: LatLon;
  private incidentId = "";
  private spread: Spread | null = null;
  private suppressionStartMs: number | null = null;
  private runs = 0;
  private notes = 0;
  private lastProgress = -1;
  private lastCaptureAt = 0;
  private lastSuppression = "";
  private readonly steps: Step[];

  constructor(
    private readonly emitEvent: Emit,
    private readonly onState: (state: Partial<DemoState>) => void,
  ) {
    this.sc = demoScenario();
    this.fire = this.sc.fireSite;
    this.steps = [
      { label: "Zone ready", durationMs: 15 * MIN, enter: () => this.enterReady() },
      { label: "Survey", durationMs: 110 * MIN, enter: () => this.enterSurvey(), update: (t) => this.updateSurvey(t) },
      { label: "Report", durationMs: 40 * MIN, enter: () => this.enterReport() },
      { label: "Hotspot found", durationMs: 25 * MIN, enter: () => this.enterHotspot() },
      { label: "Fire confirmed", durationMs: 35 * MIN, enter: () => this.enterConfirmed() },
      { label: "Suppression", durationMs: 120 * MIN, enter: () => this.enterSuppression(), update: (t) => this.updateSuppression(t) },
      { label: "Contained", durationMs: 30 * MIN, enter: () => this.enterContained() },
    ];
  }

  // --- the dummy world --------------------------------------------------------------

  /**
   * Load the dummy world: the demo zone with docks deployed, drones home, and
   * its last report filed. Nothing runs until the operator acts.
   */
  load(): void {
    this.resetWorld();
    const at = Date.now();
    this.surveyId = `survey-${at.toString(36)}`;
    this.report = makeReport(this.sc, this.surveyId, new Date(at - 3 * 60 * MIN).toISOString());
    const survey: Survey = {
      id: this.surveyId, status: "scheduled", progress_pct: 100, next_at: new Date(at + 9 * 60 * MIN).toISOString(),
      observed_pct: 98.6, missed_count: 6, last_completed: true,
    };
    this.emitSnapshot(at, false, { survey, report: this.report });
    this.setIdle();
    this.startTimer();
  }

  /** Run demo: the whole story from the start, at 360x. */
  startStory(autoplay: boolean): void {
    this.resetWorld();
    this.mode = "story";
    this.stopAt = STORY.contained;
    this.stepIndex = 0;
    const at = Date.now();
    this.emitSnapshot(at, !autoplay, { survey: { id: null, status: "scheduled", progress_pct: 0, next_at: new Date(at + 15 * MIN).toISOString() } });
    this.stepStartMs = this.now();
    this.steps[0]!.enter();
    this.onState({ status: autoplay ? "playing" : "paused", mode: "story", step: 0, steps: this.steps.length, label: this.steps[0]!.label });
    this.startTimer();
  }

  play(): void {
    const state = useAppStore.getState().demo;
    if (state.status === "done") return this.startStory(true);
    useAppStore.getState().setSimLocal({ paused: false });
    this.onState({ status: "playing" });
  }

  pause(): void {
    useAppStore.getState().setSimLocal({ paused: true });
    this.onState({ status: "paused" });
  }

  next(): void {
    const step = this.current();
    step.update?.(step.durationMs);
    this.advance();
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  // --- operator actions on the dummy world -------------------------------------------

  createZone(name: string, polygon: LatLon[]): Zone {
    const zone: Zone = {
      id: `${slug(name)}-${Date.now().toString(36).slice(-5)}`,
      name,
      polygon,
      area_km2: Math.round(polygonAreaKm2(polygon) * 1000) / 1000,
    };
    const sc = scenarioForZone(zone);
    this.world.set(zone.id, sc);
    this.emitTo(zone.id, "zone", zone);
    this.emitTo(zone.id, "zone_map", sc.map);
    this.emitTo(zone.id, "log", {
      message: `Zone ${name} saved: ${zone.area_km2.toFixed(1)} km². Towns, shelters and roads around it are dummy data (SIM).`,
      source: "demo",
    });
    return zone;
  }

  removeZone(zoneId: string): void {
    this.world.delete(zoneId);
    this.edgePlans.delete(zoneId);
    for (const [id, z] of this.droneZone) if (z === zoneId) {
      this.drones.delete(id);
      this.droneZone.delete(id);
      this.flights.delete(id);
    }
    if (this.sc.zone.id === zoneId) this.setIdle();
    this.emitTo(zoneId, "zone_removed", { id: zoneId });
  }

  suggestEdgeServers(zoneId: string): EdgePlan | undefined {
    const sc = this.world.get(zoneId);
    if (!sc) return undefined;
    const servers = dummyEdgeLayout(sc);
    const plan: EdgePlan = { servers, coverage_pct: computeCoverage(sc.grid, servers).pct };
    this.edgePlans.set(zoneId, plan);
    this.emitTo(zoneId, "edge_plan", plan);
    this.emitTo(zoneId, "log", { message: `Suggested ${servers.length} edge servers covering ${plan.coverage_pct.toFixed(1)}% of the zone (dummy layout).`, source: "demo" });
    return plan;
  }

  setEdgeServers(zoneId: string, servers: EdgeServer[], deploy: boolean): EdgePlan | undefined {
    const sc = this.world.get(zoneId);
    if (!sc) return undefined;
    const status = deploy ? "deployed" : "pending";
    const list = servers.map((s, i) => ({ ...s, id: s.id || `edge-${i + 1}`, status }) as EdgeServer);
    const plan: EdgePlan = { servers: list, coverage_pct: list.length ? computeCoverage(sc.grid, list).pct : 0 };
    this.edgePlans.set(zoneId, plan);
    this.emitTo(zoneId, "edge_plan", plan);
    if (deploy && list.length) {
      sc.docks = list.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon }));
      for (const [id, z] of this.droneZone) if (z === zoneId) this.drones.delete(id);
      const fleet = dronesOf(sc.docks).map((id) => this.dockedIn(sc, id));
      for (const d of fleet) {
        this.drones.set(d.id, d);
        this.droneZone.set(d.id, zoneId);
      }
      this.emitTo(zoneId, "fleet", { drones: fleet });
      this.emitTo(zoneId, "survey", { id: null, status: "scheduled", progress_pct: 0, next_at: new Date(this.now() + 12 * 60 * MIN).toISOString() });
      this.emitTo(zoneId, "log", { message: `Deployed ${list.length} edge servers, ${fleet.length} drones (SIM). Coverage ${plan.coverage_pct.toFixed(1)}%.`, source: "demo" });
    }
    return plan;
  }

  setShelters(zoneId: string, shelters: Shelter[]): void {
    const sc = this.world.get(zoneId);
    if (!sc) return;
    sc.map = { ...sc.map, shelters };
    this.emitTo(zoneId, "zone_map", sc.map);
  }

  /** "Run survey": the survey and its report on one zone. */
  runSurvey(zoneId: string): string | null {
    const sc = this.world.get(zoneId);
    if (!sc) return "That zone no longer exists.";
    if (sc.docks.length === 0) return "Deploy edge servers first. The drones live on their docks.";
    if (this.busy()) return "Something is already running. Wait for it to finish or pause the demo.";
    this.runPhase(sc, STORY.survey, STORY.report);
    return null;
  }

  /** "Start test fire": a hotspot at this point, verified and alerted. Returns false outside every zone. */
  startFireAt(p: LatLon): boolean {
    const active = useAppStore.getState().activeZoneId;
    const sc = (active && this.world.get(active) && insideZone(this.world.get(active)!, p) ? this.world.get(active) : undefined)
      ?? [...this.world.values()].find((z) => insideZone(z, p));
    if (!sc || sc.docks.length === 0) return false;
    this.fire = p;
    this.incidentId = `incident-${Date.now().toString(36)}`;
    this.spread = null;
    this.suppressionStartMs = null;
    if (this.mode === "story" && this.sc === sc && this.stepIndex < STORY.hotspot && useAppStore.getState().demo.status !== "idle") {
      this.goTo(STORY.hotspot);
    } else {
      this.runPhase(sc, STORY.hotspot, STORY.confirmed);
    }
    return true;
  }

  /** "Dispatch drones" on a confirmed fire. */
  dispatchSuppression(): void {
    if (this.mode === "story" && this.stepIndex < STORY.suppression && useAppStore.getState().demo.status !== "idle") {
      this.goTo(STORY.suppression);
    } else if (this.spread) {
      this.runPhase(this.sc, STORY.suppression, STORY.contained);
    }
  }

  approve(approvalId: string): void {
    const pending = useAppStore.getState().approvals[approvalId];
    if (!pending) return;
    const a = pending.payload;
    this.notify(a.tier ?? "prepare", a.recipients_count ?? 0, a.texts[0] ?? "", "operator");
    this.emit("decision", { summary: `Operator approved the ${a.tier ?? ""} alert. Sent to ${a.recipients_count ?? 0} residents (SIM).`, approval_id: approvalId });
  }

  hold(approvalId: string): void {
    if (!useAppStore.getState().approvals[approvalId]) return;
    this.emit("decision", { summary: "Operator held the alert. Nothing was sent.", approval_id: approvalId });
  }

  /** Canned agent replies for chat. */
  chat(text: string): string {
    const t = text.trim().toLowerCase();
    const s = useAppStore.getState();
    const zone = (s.activeZoneId && this.world.get(s.activeZoneId)) || this.sc;
    if (t.startsWith("approve")) {
      const id = t.split(/\s+/)[1] ?? Object.keys(s.approvals)[0];
      if (!id || !s.approvals[id]) return "Nothing is waiting for approval.";
      this.approve(id);
      return `Approved ${id}. The alert went out (demo).`;
    }
    const near = t.match(/fire near (.+)/);
    if (near) {
      const place = zone.map.communities.find((c) => c.name.toLowerCase().includes(near[1]!.trim()));
      if (!place) return `I do not know a place called "${near[1]}". Try ${zone.map.communities.map((c) => c.name).join(", ")}.`;
      // The zone point closest to that place.
      const target = zone.cells
        .map((c) => cellCenter(zone.grid, c))
        .reduce((best, p) => (Math.hypot(p[0] - place.lat, p[1] - place.lon) < Math.hypot(best[0] - place.lat, best[1] - place.lon) ? p : best), zone.fireSite);
      if (!this.startFireAt(target)) return "Deploy edge servers in this zone first, so a drone can verify the report.";
      return `Logged a reported fire near ${place.name}. A drone is on the way to verify it (demo).`;
    }
    if (t.includes("status")) {
      const incident = Object.values(s.incidents).find((i) => i.zone_id === zone.zone.id && i.status !== "contained");
      const survey = s.surveys[zone.zone.id];
      if (incident) {
        return `${zone.zone.name}: fire ${incident.status} at confidence ${incident.confidence.toFixed(2)}. ${Object.keys(s.approvals).length} alerts wait for approval.`;
      }
      return `${zone.zone.name}: no active fire. Survey ${survey?.status ?? "not scheduled"}. ${s.reports[zone.zone.id] ? "The latest report is ready." : ""}`.trim();
    }
    return `Try "status", "approve", or "fire near ${zone.map.communities[0]?.name ?? "a town"}".`;
  }

  // --- clock and steps ------------------------------------------------------------

  private resetWorld(): void {
    this.world.clear();
    this.edgePlans.clear();
    this.drones.clear();
    this.droneZone.clear();
    this.flights.clear();
    this.observed.clear();
    this.sc = demoScenario();
    this.world.set(this.sc.zone.id, this.sc);
    this.edgePlans.set(this.sc.zone.id, {
      servers: this.sc.docks.map((d) => ({ ...d, radius_m: 1500, status: "deployed" as const, near_road: true })),
      coverage_pct: 96.4,
    });
    for (const id of dronesOf(this.sc.docks)) {
      this.drones.set(id, this.dockedIn(this.sc, id));
      this.droneZone.set(id, this.sc.zone.id);
    }
    this.fire = this.sc.fireSite;
    this.report = null;
    this.spread = null;
    this.suppressionStartMs = null;
    this.runs = 0;
    this.notes = 0;
    this.lastProgress = -1;
    this.lastCaptureAt = 0;
    this.lastSuppression = "";
    const stamp = Date.now().toString(36);
    this.surveyId = `survey-${stamp}`;
    this.incidentId = `incident-${stamp}`;
  }

  private startTimer(): void {
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  private setIdle(): void {
    this.mode = "phase";
    this.onState({ status: "idle", mode: "phase", step: 0, steps: 0, label: "" });
  }

  private busy(): boolean {
    const status = useAppStore.getState().demo.status;
    return status === "playing" || status === "paused";
  }

  /** Run steps `from` to `to` of the story on one zone, then go idle. */
  private runPhase(sc: Scenario, from: number, to: number): void {
    this.sc = sc;
    this.mode = "phase";
    this.stopAt = to;
    this.stepIndex = from;
    this.stepStartMs = this.now();
    if (from === STORY.survey) {
      this.surveyId = `survey-${Date.now().toString(36)}`;
      this.observed.clear();
      this.lastProgress = -1;
      this.lastCaptureAt = 0;
    }
    if (from === STORY.suppression) this.lastSuppression = "";
    useAppStore.getState().setSimLocal({ paused: false });
    this.current().enter();
    this.onState({ status: "playing", mode: "phase", step: from, steps: this.steps.length, label: this.current().label });
  }

  private now(): number {
    const sim = useAppStore.getState().sim;
    return sim ? simNow(sim) : Date.now();
  }

  private elapsed(): number {
    return this.now() - this.stepStartMs;
  }

  private current(): Step {
    return this.steps[this.stepIndex]!;
  }

  /** Jump ahead in the story: finish the current step, run skipped ones instantly, enter `index`. */
  private goTo(index: number): void {
    while (this.stepIndex < index) {
      const step = this.current();
      step.update?.(step.durationMs);
      this.stepIndex += 1;
      this.stepStartMs = this.now();
      this.current().enter();
    }
    this.onState({ step: index, label: this.current().label });
  }

  private advance(): void {
    if (this.stepIndex >= this.stopAt) {
      if (this.mode === "story") this.onState({ status: "done" });
      else this.setIdle();
      return;
    }
    this.stepIndex += 1;
    this.stepStartMs = this.now();
    this.current().enter();
    this.onState({ step: this.stepIndex, label: this.current().label });
  }

  private tick(): void {
    const sim = useAppStore.getState().sim;
    if (!sim || sim.paused) return;
    const status = useAppStore.getState().demo.status;
    if (status === "playing") {
      const step = this.current();
      const elapsed = this.elapsed();
      step.update?.(Math.min(elapsed, step.durationMs));
      if (elapsed >= step.durationMs) this.advance();
    }
    this.moveDrones();
  }

  // --- events ----------------------------------------------------------------------

  private ts(): string {
    return new Date(this.now()).toISOString();
  }

  private emitTo(zoneId: string, kind: string, payload: unknown): void {
    this.emitEvent({ kind, zone_id: zoneId, ts: this.ts(), payload } as KnownEvent);
  }

  /** An event about the zone the story or current phase is running on. */
  private emit(kind: string, payload: unknown): void {
    this.emitTo(this.sc.zone.id, kind, payload);
  }

  private emitSnapshot(atMs: number, paused: boolean, extra: { survey: Survey; report?: Report }): void {
    const id = this.sc.zone.id;
    const snapshot: Snapshot = {
      sim: { sim_time: new Date(atMs).toISOString(), speed: DEMO_SPEED, paused },
      zones: [this.sc.zone],
      zone_maps: { [id]: this.sc.map },
      survey_cells: {},
      edge_plans: { [id]: this.edgePlans.get(id)! },
      drones: [...this.drones.values()].map((d) => ({ ...d, zone_id: id })),
      surveys: { [id]: extra.survey },
      reports: extra.report ? { [id]: extra.report } : {},
      captures: [],
      incidents: [],
      approvals: [],
      notifications: [],
      suppression: [],
      log: [
        {
          kind: "log",
          zone_id: id,
          ts: new Date(atMs).toISOString(),
          payload: { message: "Dummy data loaded. Every drone, fire, resident and alert on this console is simulated.", source: "demo" },
        },
      ],
    };
    this.emitEvent({ kind: "snapshot", zone_id: "*", ts: snapshot.sim.sim_time, payload: snapshot });
  }

  private agentRun(trigger: string, mode: AgentMode = "fallback"): string {
    this.runs += 1;
    const runId = `run-${Date.now().toString(36)}-${this.runs}`;
    this.emit("agent_run", { run_id: runId, trigger, mode });
    return runId;
  }

  private step(runId: string, tool: string, message: string, args: Record<string, unknown>, result: unknown): void {
    this.emit("log", { run_id: runId, tool, message, args, result, source: "agent" });
  }

  private notify(tier: Tier, count: number, text: string, approvedBy: string, routeId?: string, shelter?: string): void {
    this.notes += 1;
    this.emit("notification", {
      id: `note-${Date.now().toString(36)}-${this.notes}`,
      tier,
      recipients_count: count,
      text,
      audio_url: null,
      approved_by: approvedBy,
      incident_id: this.incidentId,
      route_id: routeId ?? null,
      shelter: shelter ?? null,
    } satisfies Notification);
  }

  // --- drones ----------------------------------------------------------------------

  private dockedIn(sc: Scenario, id: string, battery = 100): Drone {
    const dock = dockOf(sc, id);
    return { id, lat: dock.lat, lon: dock.lon, alt_m: 0, heading_deg: 0, battery_pct: battery, state: battery < 100 ? "charging" : "docked", dock_id: dock.id, sortie: null, simulated: true };
  }

  private fly(id: string, path: LatLon[], durationMs: number, state: DroneState, cells?: [number, number][]): void {
    this.flights.set(id, { path, cumulative: pathLength(path), startMs: this.now(), durationMs, state, cells });
  }

  private moveDrones(): void {
    const now = this.now();
    const real = performance.now();
    const send = real - this.lastTelemetry >= TELEMETRY_MS;
    const newCells: number[] = [];
    for (const [id, f] of this.flights) {
      const zoneId = this.droneZone.get(id);
      const sc = zoneId ? this.world.get(zoneId) : undefined;
      const drone = this.drones.get(id);
      if (!sc || !drone) {
        this.flights.delete(id);
        continue;
      }
      const total = f.cumulative[f.cumulative.length - 1]!;
      const t = Math.min(1, (now - f.startMs) / f.durationMs);
      const { at, heading } = pointAt(f, t * total);
      if (f.cells) {
        while (f.cells.length && f.cells[0]![0] <= t * total) {
          const cell = f.cells.shift()![1];
          if (!this.observed.has(cell)) {
            this.observed.add(cell);
            newCells.push(cell);
          }
        }
      }
      const battery = Math.max(25, drone.battery_pct - (f.state === "surveying" ? 0.02 : 0.03));
      const next: Drone =
        t >= 1
          ? this.dockedIn(sc, id, Math.round(battery))
          : { ...drone, lat: at[0], lon: at[1], alt_m: 120, heading_deg: heading, battery_pct: battery, state: f.state };
      this.drones.set(id, next);
      if (t >= 1) {
        this.flights.delete(id);
        this.emitTo(sc.zone.id, "drone", next);
      } else if (send) {
        this.emitTo(sc.zone.id, "drone", next);
      }
    }
    // Docked drones recharge.
    for (const [id, d] of this.drones) {
      if (this.flights.has(id) || d.battery_pct >= 100) continue;
      const charged = { ...d, battery_pct: Math.min(100, d.battery_pct + 0.05) };
      charged.state = charged.battery_pct >= 100 ? "docked" : "charging";
      this.drones.set(id, charged);
      const zoneId = this.droneZone.get(id);
      if (send && zoneId) this.emitTo(zoneId, "drone", charged);
    }
    if (send) this.lastTelemetry = real;
    if (newCells.length) this.emit("survey_cells", { survey_id: this.surveyId, cells: newCells });
  }

  // --- story ------------------------------------------------------------------------

  private enterReady(): void {
    this.emit("log", { message: `Edge servers deployed: ${this.sc.docks.length} docks, ${this.sc.docks.length * 2} drones.`, source: "demo" });
  }

  private enterSurvey(): void {
    const sc = this.sc;
    this.emit("survey", { id: this.surveyId, status: "running", progress_pct: 0, next_at: null, observed_pct: 0 });
    this.emit("survey_cells", { survey_id: this.surveyId, cells: [], reset: true });
    this.emit("log", { message: `Survey started: ${sc.docks.length * 2} drones from ${sc.docks.length} docks.`, source: "fleet" });
    for (const [id, { path, cells }] of surveyPaths(sc)) {
      this.fly(id, path, this.current().durationMs * (0.9 + Math.random() * 0.08), "surveying", [...cells]);
    }
  }

  private updateSurvey(elapsedMs: number): void {
    const sc = this.sc;
    const pct = Math.min(100, Math.round((100 * this.observed.size) / Math.max(1, sc.cells.length)));
    if (elapsedMs >= this.current().durationMs) {
      // Finish the sweep even when the step was skipped.
      const rest = sc.cells.filter((c) => !this.observed.has(c));
      rest.forEach((c) => this.observed.add(c));
      if (rest.length) this.emit("survey_cells", { survey_id: this.surveyId, cells: rest });
      for (const id of dronesOf(sc.docks)) {
        this.flights.delete(id);
        this.drones.set(id, this.dockedIn(sc, id, 62));
      }
      this.emit("fleet", { drones: dronesOf(sc.docks).map((id) => this.drones.get(id)!) });
      return;
    }
    if (pct !== this.lastProgress) {
      this.lastProgress = pct;
      this.emit("survey", { id: this.surveyId, status: "running", progress_pct: pct, next_at: null, observed_pct: pct });
    }
    // A routine photo every 400 cells imaged, where the last one was.
    if (this.observed.size - this.lastCaptureAt >= 400) {
      this.lastCaptureAt = this.observed.size;
      const [lat, lon] = cellCenter(sc.grid, [...this.observed].pop()!);
      this.emit("capture", { id: `cap-${this.surveyId}-${this.observed.size}`, survey_id: this.surveyId, lat, lon, image_url: null, kind: "rgb", simulated: true });
    }
  }

  private enterReport(): void {
    const sc = this.sc;
    const next = new Date(this.now() + 12 * 60 * MIN - 110 * MIN).toISOString();
    const done = { id: this.surveyId, progress_pct: 100, next_at: next, observed_pct: 98.6, missed_count: 6, last_completed: true };
    this.emit("survey", { ...done, status: "complete" });
    this.emit("survey", { ...done, status: "scheduled" });
    this.emit("capture", { id: `cap-${this.surveyId}-thermal`, survey_id: this.surveyId, lat: sc.fireSite[0], lon: sc.fireSite[1], image_url: null, kind: "thermal", simulated: true });
    this.emit("log", { message: "Survey complete: observed 98.6% of the zone. 6 cells missed behind a ridge.", source: "fleet" });
    const run = this.agentRun("Survey complete");
    this.report = makeReport(sc, this.surveyId, this.ts());
    const top = this.report.sites[0]!;
    this.step(run, "build_vulnerability_report", `Scored ${sc.cells.length.toLocaleString("en-US")} cells and ranked ${this.report.sites.length} sites.`, { survey_id: this.surveyId }, { sites: this.report.sites.length, top_score: top.peak_score });
    this.emit("report", this.report);
    this.emit("decision", {
      run_id: run,
      summary: `Report filed. Top site scores ${top.peak_score}, ${top.community_distance_km} km from ${top.nearest_community}.`,
      actions: ["Prioritize fuel clearing at site 1", "Survey again in 6 hours"],
    });
  }

  private nearestTown(): string {
    const spread = this.spread;
    const first = spread?.communities.filter((c) => c.arrival_min !== null).sort((a, b) => a.arrival_min! - b.arrival_min!)[0];
    return first?.name ?? this.sc.map.communities[0]?.name ?? "the nearest town";
  }

  private enterHotspot(): void {
    const id = this.incidentId;
    this.emit("incident", { id, lat: this.fire[0], lon: this.fire[1], status: "suspected", confidence: 0.62 });
    const run = this.agentRun("Thermal anomaly reported");
    this.step(run, "read_detections", "One thermal detection, confidence 0.62, not yet confirmed by a drone.", { zone_id: this.sc.zone.id }, { detections: 1, confidence: 0.62 });
    this.step(run, "read_conditions", "Wind at 24 km/h, humidity 9%. Red flag warning.", { lat: this.fire[0], lon: this.fire[1] }, { wind_kmh: 24, humidity_pct: 9, red_flag: true });
    this.spread = spreadField(this.sc, this.fire, id);
    this.emit("spread", this.spread);
    const town = this.nearestTown();
    this.step(run, "predict_spread", `Preliminary prediction: the head runs toward ${town}.`, { incident_id: id, horizon_min: 360 }, { cells: this.spread.cells.length, head_bearing_deg: Math.round(this.sc.headBearingDeg) });
    const approval: ApprovalRequest = {
      id: `approval-${id}`,
      reason: "The fire is not yet confirmed by a drone (confidence 0.62, below 0.8). Alerts wait for an operator.",
      tier: "prepare",
      texts: [`Demo alert. A wildfire may be burning near ${town}. Be ready to leave. Watch for updates.`],
      recipients_count: 84,
      incident_id: id,
    };
    this.step(run, "notify", "Prepared a prepare-tier alert for 84 residents and held it for approval.", { tier: "prepare", recipients: 84 }, { held: true });
    this.emit("approval_request", approval);
    const dock = nearestDock(this.sc, this.fire);
    const drone = `${dock.id}-d1`;
    this.step(run, "dispatch_response", `Sent ${drone} to verify the hotspot.`, { drone_id: drone }, { eta_min: 6 });
    this.emit("dispatch", { message: `Sent ${drone} to verify the hotspot.`, incident_id: id, drone_ids: [drone] });
    this.fly(drone, [[dock.lat, dock.lon], this.fire, [this.fire[0] + 0.0015, this.fire[1]], this.fire], this.current().durationMs * 0.9, "verifying");
    this.emit("decision", { run_id: run, summary: `Hotspot reported. A drone is verifying it. The prepare alert for ${town} waits for approval.` });
  }

  private enterConfirmed(): void {
    const sc = this.sc;
    const id = this.incidentId;
    this.emit("incident", { id, lat: this.fire[0], lon: this.fire[1], status: "confirmed", confidence: 0.86 });
    const run = this.agentRun("Drone confirmed the fire at 0.86");
    this.spread = spreadField(sc, this.fire, id);
    this.emit("spread", this.spread);
    const town = this.nearestTown();
    const arrival = this.spread.communities.find((c) => c.name === town)?.arrival_min;
    this.step(run, "predict_spread", `Confirmed fire. The head reaches ${town} in about ${arrival ? Math.round(arrival / 6) / 10 : "several"} hours.`, { incident_id: id }, { cells: this.spread.cells.length });
    const routes = routesFor(sc, id, this.spread);
    for (const r of routes) this.emit("route", r);
    this.step(run, "plan_evacuation", `Routes planned: ${routes.map((r) => `${r.community} to ${r.shelter} (${r.distance_km} km)`).join(", ") || "none needed"}.`, { incident_id: id }, { routes: routes.length });
    const people = residents(sc, this.fire, this.spread);
    this.emit("recipients", { incident_id: id, residents: people, simulated: true });
    const count = (tier: string) => people.filter((p) => p.tier === tier).length;
    const policy = "policy: drone-confirmed at 0.86";
    const evacRoute = routes[0];
    this.notify("evacuate", count("evacuate"), alertText(sc, "evacuate", evacRoute), policy, evacRoute?.id, evacRoute?.shelter);
    this.notify("prepare", count("prepare"), alertText(sc, "prepare"), policy);
    this.notify("watch", count("watch"), alertText(sc, "watch"), policy);
    this.step(run, "notify", `Sent alerts by tier: ${count("evacuate")} evacuate, ${count("prepare")} prepare, ${count("watch")} watch (SIM residents).`, { incident_id: id }, { sent: true });
    const held = `approval-${id}`;
    if (useAppStore.getState().approvals[held]) {
      this.emit("decision", { run_id: run, approval_id: held, summary: "The held prepare alert is no longer needed: the confirmed fire sent alerts under policy." });
    }
    this.step(run, "log_decision", "Logged the decision.", {}, { ok: true });
    this.emit("decision", { run_id: run, summary: "Fire confirmed. Residents alerted by tier. Evacuation routes are open.", actions: [`Evacuate ${town}`, "Dispatch suppression drones"] });
  }

  private enterSuppression(): void {
    this.suppressionStartMs = this.now();
    const run = this.agentRun("Operator dispatched suppression drones", "policy");
    const band = this.spread ? headBand(this.spread) : [];
    const count = Math.min(6, dronesOf(this.sc.docks).length);
    this.step(run, "dispatch_suppression", `Assigned ${count} drones to the head band, ${band.length} cells 20 to 60 minutes out.`, { incident_id: this.incidentId }, { drones: count, sorties_planned: 12 });
    this.emit("suppression", { incident_id: this.incidentId, sorties_done: 0, sorties_planned: 12, containment_pct: 0, treated_cells: [], simulated: true });
    this.flySuppression();
  }

  private flySuppression(): void {
    const band = this.spread ? headBand(this.spread) : [];
    const target: LatLon = band[Math.floor(band.length / 2)] ?? this.fire;
    dronesOf(this.sc.docks).slice(0, 6).forEach((id, k) => {
      if (this.flights.has(id)) return;
      const dock = dockOf(this.sc, id);
      const spot: LatLon = [target[0] + (k - 3) * 0.001, target[1] + (k % 2 ? 0.002 : -0.002)];
      this.fly(id, [[dock.lat, dock.lon], spot, [dock.lat, dock.lon]], 18 * MIN, "suppressing");
    });
  }

  private updateSuppression(elapsedMs: number): void {
    if (this.suppressionStartMs === null || !this.spread) return;
    const share = Math.min(1, elapsedMs / this.current().durationMs);
    const sorties = Math.min(12, Math.floor(share * 12.5));
    const containment = Math.round(Math.min(84, share * 92));
    const band = headBand(spreadField(this.sc, this.fire, this.incidentId));
    const treated = band.slice(0, Math.round(band.length * Math.min(1, share * 1.2)));
    // Report every sortie, and every 4 points of containment.
    const key = `${sorties}:${Math.floor(containment / 4)}`;
    if (key !== this.lastSuppression) {
      this.lastSuppression = key;
      this.emit("suppression", { incident_id: this.incidentId, sorties_done: sorties, sorties_planned: 12, containment_pct: containment, treated_cells: treated, simulated: true });
      this.spread = spreadField(this.sc, this.fire, this.incidentId, containment / 100);
      this.emit("spread", this.spread);
    }
    if (share < 0.85) this.flySuppression();
  }

  private enterContained(): void {
    this.emit("incident", { id: this.incidentId, lat: this.fire[0], lon: this.fire[1], status: "contained", confidence: 0.86 });
    const run = this.agentRun("Containment passed 80%", "policy");
    this.step(run, "log_decision", "Containment 84%. The predicted burn area shrank by about four fifths.", {}, { containment_pct: 84 });
    this.emit("decision", { run_id: run, summary: "Fire contained at 84%. Keep evacuation orders until crews confirm. Next survey on schedule.", actions: ["Hold evacuation orders", "Survey again in 6 hours"] });
  }
}
