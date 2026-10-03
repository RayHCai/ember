import { cellCenter, projector } from "../../geo/grid";
import { simNow, useAppStore, type DemoState } from "../../state/store";
import type {
  AgentMode,
  ApprovalRequest,
  Drone,
  DroneState,
  KnownEvent,
  LatLon,
  Notification,
  Report,
  Snapshot,
  Spread,
} from "../../types/events";
import {
  DOCKS,
  DRONE_IDS,
  EDGE_PLAN,
  FIRE_SITE,
  GRID,
  ZONE,
  ZONE_CELLS,
  ZONE_ID,
  ZONE_MAP,
  dockOf,
  headBand,
  insideZone,
  makeReport,
  nearestDock,
  residents,
  routesFor,
  spreadField,
} from "./scenario";

// Plays the demo scenario as events, on the console's own sim clock (so the
// top bar's speed and pause buttons drive it). All data is SIMULATED.

type Emit = (event: KnownEvent) => void;

const MIN = 60_000;
const DEMO_SPEED = 360;
const TELEMETRY_MS = 250;

interface Flight {
  path: LatLon[];
  cumulative: number[];
  startMs: number;
  durationMs: number;
  state: DroneState;
  /** Cells imaged along the way, by distance along the path. */
  cells?: [number, number][];
  endState: DroneState;
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
  const project = projector(a);
  const [bx, by] = project(b);
  return {
    at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    heading: ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360,
  };
}

/** Survey paths for the demo: each dock's nearest cells, swept in rows by its two drones. */
function surveyPaths(): Map<string, { path: LatLon[]; cells: [number, number][] }> {
  const byDock = new Map<string, number[]>();
  const project = projector(ZONE.polygon[0]!);
  const dockXY = DOCKS.map((d) => ({ id: d.id, xy: project([d.lat, d.lon]) }));
  for (const cell of ZONE_CELLS) {
    const [x, y] = project(cellCenter(GRID, cell));
    const near = dockXY.reduce((b, d) => ((d.xy[0] - x) ** 2 + (d.xy[1] - y) ** 2 < (b.xy[0] - x) ** 2 + (b.xy[1] - y) ** 2 ? d : b));
    byDock.set(near.id, [...(byDock.get(near.id) ?? []), cell]);
  }
  const out = new Map<string, { path: LatLon[]; cells: [number, number][] }>();
  for (const dock of DOCKS) {
    const rows = new Map<number, number[]>();
    for (const cell of byDock.get(dock.id) ?? []) {
      const band = Math.floor(cell / GRID.cols / 2); // one pass per two rows
      rows.set(band, [...(rows.get(band) ?? []), cell]);
    }
    const bands = [...rows.keys()].sort((a, b) => a - b);
    [0, 1].forEach((k) => {
      const mine = bands.filter((_, i) => i % 2 === k);
      const path: LatLon[] = [[dock.lat, dock.lon]];
      const cells: [number, LatLon][] = [];
      mine.forEach((band, i) => {
        const bandCells = rows.get(band)!;
        const cols = bandCells.map((c) => c % GRID.cols);
        const lat = GRID.south + (band * 2 + 1) * GRID.dlat;
        const west = GRID.west + (Math.min(...cols) + 0.5) * GRID.dlon;
        const east = GRID.west + (Math.max(...cols) + 0.5) * GRID.dlon;
        const [from, to] = i % 2 === 0 ? [west, east] : [east, west];
        path.push([lat, from], [lat, to]);
        for (const c of bandCells) cells.push([c, cellCenter(GRID, c)]);
      });
      path.push([dock.lat, dock.lon]);
      // Distance along the path where each cell is closest.
      const cum = pathLength(path);
      const located: [number, number][] = cells.map(([c, p]) => {
        let best = 0;
        let bestD = Infinity;
        for (let s = 1; s < path.length; s++) {
          const [ax, ay] = project(path[s - 1]!);
          const [bx, by] = project(path[s]!);
          const [px, py] = project(p);
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

export class DemoPlayer {
  private timer = 0;
  private stepIndex = 0;
  private stepStartMs = 0;
  private lastTelemetry = 0;
  private drones = new Map<string, Drone>();
  private flights = new Map<string, Flight>();
  private observed = new Set<number>();
  private surveyId = "demo-survey-1";
  private report: Report | null = null;
  private fire: LatLon = FIRE_SITE;
  private incidentId = "demo-incident-1";
  private spread: Spread | null = null;
  private suppressionStartMs: number | null = null;
  private runs = 0;
  private notes = 0;
  private lastProgress = -1;
  private lastCaptureAt = 0;
  private lastSuppression = "";
  private readonly steps: Step[];
  private readonly paths = surveyPaths();

  constructor(
    private readonly emitEvent: Emit,
    private readonly onState: (state: Partial<DemoState>) => void,
  ) {
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

  // --- controls -----------------------------------------------------------------

  /** Restore the starting snapshot, paused on the first step. */
  reset(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.drones.clear();
    this.flights.clear();
    this.observed.clear();
    this.report = null;
    this.spread = null;
    this.fire = FIRE_SITE;
    this.suppressionStartMs = null;
    this.runs = 0;
    this.notes = 0;
    this.lastProgress = -1;
    this.lastCaptureAt = 0;
    this.lastSuppression = "";
    this.stepIndex = 0;
    this.surveyId = `demo-survey-${Date.now().toString(36)}`;
    this.incidentId = `demo-incident-${Date.now().toString(36)}`;
    for (const id of DRONE_IDS) this.drones.set(id, this.docked(id));
    this.emitSnapshot(Date.now(), true);
    this.stepStartMs = this.now();
    this.steps[0]!.enter();
    this.onState({ status: "paused", step: 0, steps: this.steps.length, label: this.steps[0]!.label });
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  play(): void {
    if (this.stepIndex >= this.steps.length - 1 && this.elapsed() >= this.current().durationMs) this.reset();
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

  /** "Start test fire" from the console: jump to the hotspot at this point. */
  startFireAt(p: LatLon): boolean {
    if (!insideZone(p)) return false;
    this.fire = p;
    this.incidentId = `demo-incident-${Date.now().toString(36)}`;
    this.goTo(3);
    return true;
  }

  dispatchSuppression(): void {
    if (this.stepIndex < 5) this.goTo(5);
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

  /** Canned agent replies for the demo chat. */
  chat(text: string): string {
    const t = text.trim().toLowerCase();
    const s = useAppStore.getState();
    if (t.startsWith("approve")) {
      const id = t.split(/\s+/)[1] ?? Object.keys(s.approvals)[0];
      if (!id || !s.approvals[id]) return "Nothing is waiting for approval.";
      this.approve(id);
      return `Approved ${id}. The alert went out (demo).`;
    }
    const near = t.match(/fire near (.+)/);
    if (near) {
      const place = ZONE_MAP.communities.find((c) => c.name.toLowerCase().includes(near[1]!.trim()));
      if (!place) return `I do not know a place called "${near[1]}". Try Sierra Madre, Arcadia or Altadena.`;
      const p: LatLon = [Math.min(ZONE.polygon[0]![0] - 0.004, place.lat + 0.03), place.lon];
      if (!this.startFireAt(insideZone(p) ? p : FIRE_SITE)) return "That point is outside the watch zone.";
      return `Logged a reported fire near ${place.name}. A drone is on the way to verify it (demo).`;
    }
    if (t.includes("status")) {
      const incident = Object.values(s.incidents).find((i) => i.status !== "contained");
      const survey = s.surveys[ZONE_ID];
      if (incident) {
        return `${ZONE.name}: fire ${incident.status} at confidence ${incident.confidence.toFixed(2)}. ${Object.keys(s.approvals).length} alerts wait for approval.`;
      }
      return `${ZONE.name}: no active fire. Survey ${survey?.status ?? "scheduled"}. ${s.reports[ZONE_ID] ? "The latest report is ready." : ""}`;
    }
    return 'Try "status", "approve", or "fire near Sierra Madre".';
  }

  // --- clock and steps ------------------------------------------------------------

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

  /** Jump ahead: finish the current step, run any skipped ones instantly, enter `index`. */
  private goTo(index: number): void {
    if (index <= this.stepIndex) {
      this.stepStartMs = this.now();
      this.current().enter();
      return;
    }
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
    if (this.stepIndex >= this.steps.length - 1) {
      this.onState({ status: "done" });
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
    const step = this.current();
    const elapsed = this.elapsed();
    step.update?.(Math.min(elapsed, step.durationMs));
    this.moveDrones();
    if (elapsed >= step.durationMs && useAppStore.getState().demo.status === "playing") this.advance();
  }

  // --- events ----------------------------------------------------------------------

  private ts(): string {
    return new Date(this.now()).toISOString();
  }

  private emit(kind: string, payload: unknown): void {
    this.emitEvent({ kind, zone_id: ZONE_ID, ts: this.ts(), payload } as KnownEvent);
  }

  private emitSnapshot(atMs: number, paused: boolean): void {
    const snapshot: Snapshot = {
      sim: { sim_time: new Date(atMs).toISOString(), speed: DEMO_SPEED, paused },
      zones: [ZONE],
      zone_maps: { [ZONE_ID]: ZONE_MAP },
      survey_cells: {},
      edge_plans: { [ZONE_ID]: EDGE_PLAN },
      drones: [...this.drones.values()],
      surveys: { [ZONE_ID]: { id: null, status: "scheduled", progress_pct: 0, next_at: new Date(atMs + 15 * MIN).toISOString() } },
      reports: {},
      captures: [],
      incidents: [],
      approvals: [],
      notifications: [],
      suppression: [],
      log: [
        {
          kind: "log",
          zone_id: ZONE_ID,
          ts: new Date(atMs).toISOString(),
          payload: { message: "Demo loaded. Every drone, fire, resident and alert in this demo is simulated.", source: "demo" },
        },
      ],
    };
    this.emitEvent({ kind: "snapshot", zone_id: "*", ts: snapshot.sim.sim_time, payload: snapshot });
  }

  private agentRun(trigger: string, mode: AgentMode = "fallback"): string {
    this.runs += 1;
    const runId = `demo-run-${this.runs}`;
    this.emit("agent_run", { run_id: runId, trigger, mode });
    return runId;
  }

  private step(runId: string, tool: string, message: string, args: Record<string, unknown>, result: unknown): void {
    this.emit("log", { run_id: runId, tool, message, args, result, source: "agent" });
  }

  private notify(tier: Notification["tier"], count: number, text: string, approvedBy: string, routeId?: string): void {
    this.notes += 1;
    this.emit("notification", {
      id: `demo-note-${this.notes}`,
      tier,
      recipients_count: count,
      text,
      audio_url: null,
      approved_by: approvedBy,
      incident_id: this.incidentId,
      route_id: routeId ?? null,
      shelter: tier === "evacuate" ? "Arcadia High School" : null,
    } satisfies Notification);
  }

  // --- drones ----------------------------------------------------------------------

  private docked(id: string, battery = 100): Drone {
    const dock = dockOf(id);
    return { id, lat: dock.lat, lon: dock.lon, alt_m: 0, heading_deg: 0, battery_pct: battery, state: battery < 100 ? "charging" : "docked", dock_id: dock.id, sortie: null, simulated: true };
  }

  private fly(id: string, path: LatLon[], durationMs: number, state: DroneState, cells?: [number, number][]): void {
    this.flights.set(id, { path, cumulative: pathLength(path), startMs: this.now(), durationMs, state, cells, endState: "charging" });
  }

  private moveDrones(): void {
    const now = this.now();
    const real = performance.now();
    const send = real - this.lastTelemetry >= TELEMETRY_MS;
    const newCells: number[] = [];
    for (const [id, f] of this.flights) {
      const total = f.cumulative[f.cumulative.length - 1]!;
      const t = Math.min(1, (now - f.startMs) / f.durationMs);
      const { at, heading } = pointAt(f, t * total);
      const drone = this.drones.get(id)!;
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
          ? { ...this.docked(id, Math.round(battery)) }
          : { ...drone, lat: at[0], lon: at[1], alt_m: 120, heading_deg: heading, battery_pct: battery, state: f.state };
      this.drones.set(id, next);
      if (t >= 1) {
        this.flights.delete(id);
        this.emit("drone", next);
      } else if (send) {
        this.emit("drone", next);
      }
    }
    // Docked drones recharge.
    for (const [id, d] of this.drones) {
      if (this.flights.has(id) || d.battery_pct >= 100) continue;
      const charged = { ...d, battery_pct: Math.min(100, d.battery_pct + 0.05) };
      charged.state = charged.battery_pct >= 100 ? "docked" : "charging";
      this.drones.set(id, charged);
      if (send) this.emit("drone", charged);
    }
    if (send) this.lastTelemetry = real;
    if (newCells.length) this.emit("survey_cells", { survey_id: this.surveyId, cells: newCells });
  }

  // --- story ------------------------------------------------------------------------

  private enterReady(): void {
    this.emit("log", { message: "Edge servers deployed: 4 docks, 8 drones, 96.4% coverage.", source: "demo" });
  }

  private enterSurvey(): void {
    this.emit("survey", { id: this.surveyId, status: "running", progress_pct: 0, next_at: null, observed_pct: 0 });
    this.emit("survey_cells", { survey_id: this.surveyId, cells: [], reset: true });
    this.emit("log", { message: "Survey started: 8 drones from 4 docks.", source: "fleet" });
    for (const [id, { path, cells }] of this.paths) {
      this.fly(id, path, this.current().durationMs * (0.9 + Math.random() * 0.08), "surveying", [...cells]);
    }
  }

  private updateSurvey(elapsedMs: number): void {
    const pct = Math.min(100, Math.round((100 * this.observed.size) / ZONE_CELLS.length));
    if (elapsedMs >= this.current().durationMs) {
      // Make sure the sweep finishes even when the step was skipped.
      const rest = ZONE_CELLS.filter((c) => !this.observed.has(c));
      rest.forEach((c) => this.observed.add(c));
      if (rest.length) this.emit("survey_cells", { survey_id: this.surveyId, cells: rest });
      for (const id of DRONE_IDS) {
        this.flights.delete(id);
        this.drones.set(id, this.docked(id, 62));
      }
      this.emit("fleet", { drones: [...this.drones.values()] });
      return;
    }
    if (pct !== this.lastProgress) {
      this.lastProgress = pct;
      this.emit("survey", { id: this.surveyId, status: "running", progress_pct: pct, next_at: null, observed_pct: pct });
    }
    // A routine photo every 400 cells imaged, where the last one was.
    if (this.observed.size - this.lastCaptureAt >= 400) {
      this.lastCaptureAt = this.observed.size;
      const [lat, lon] = cellCenter(GRID, [...this.observed].pop()!);
      this.emit("capture", { id: `demo-cap-${this.observed.size}`, survey_id: this.surveyId, lat, lon, image_url: null, kind: "rgb", simulated: true });
    }
  }

  private enterReport(): void {
    const next = new Date(this.now() + 12 * 60 * MIN - 110 * MIN).toISOString();
    this.emit("survey", { id: this.surveyId, status: "complete", progress_pct: 100, next_at: next, observed_pct: 98.6, missed_count: 6, last_completed: true });
    this.emit("survey", { id: this.surveyId, status: "scheduled", progress_pct: 100, next_at: next, observed_pct: 98.6, missed_count: 6, last_completed: true });
    this.emit("capture", { id: "demo-cap-thermal", survey_id: this.surveyId, lat: FIRE_SITE[0], lon: FIRE_SITE[1], image_url: null, kind: "thermal", simulated: true });
    this.emit("log", { message: "Survey complete: observed 98.6% of the zone. 6 cells missed behind a ridge.", source: "fleet" });
    const run = this.agentRun("Survey complete");
    this.step(run, "build_vulnerability_report", "Scored 2,140 cells and ranked 5 sites.", { survey_id: this.surveyId }, { sites: 5, top_score: 93 });
    this.report = makeReport(this.surveyId, this.ts());
    this.emit("report", this.report);
    this.emit("decision", { run_id: run, summary: "Report filed. Top site scores 93, 2.9 km north of Sierra Madre.", actions: ["Prioritize fuel clearing at site 1", "Survey again in 6 hours"] });
  }

  private enterHotspot(): void {
    const id = this.incidentId;
    this.emit("incident", { id, lat: this.fire[0], lon: this.fire[1], status: "suspected", confidence: 0.62 });
    const run = this.agentRun("Thermal anomaly reported at the top site");
    this.step(run, "read_detections", "One thermal detection, confidence 0.62, not yet confirmed by a drone.", { zone_id: ZONE_ID }, { detections: 1, confidence: 0.62 });
    this.step(run, "read_conditions", "Wind from the north-east at 24 km/h, humidity 9%. Red flag warning.", { lat: this.fire[0], lon: this.fire[1] }, { wind_kmh: 24, wind_from_deg: 30, humidity_pct: 9, red_flag: true });
    this.spread = spreadField(this.fire, id);
    this.emit("spread", this.spread);
    this.step(run, "predict_spread", "Preliminary: the head runs south-south-west and could reach Sierra Madre in about 2.5 hours.", { incident_id: id, horizon_min: 360 }, { cells: this.spread.cells.length, head_bearing_deg: 200 });
    const approval: ApprovalRequest = {
      id: `demo-approval-${id}`,
      reason: "The fire is not yet confirmed by a drone (confidence 0.62, below 0.8). Alerts wait for an operator.",
      tier: "prepare",
      texts: ["Demo alert. A wildfire may be burning 3 km north of Sierra Madre. Be ready to leave. Watch for updates."],
      recipients_count: 84,
      incident_id: id,
    };
    this.step(run, "notify", "Prepared a prepare-tier alert for 84 residents and held it for approval.", { tier: "prepare", recipients: 84 }, { held: true });
    this.emit("approval_request", approval);
    const dock = nearestDock(this.fire);
    const drone = `${dock.id}-d1`;
    this.step(run, "dispatch_response", `Sent ${drone} to verify the hotspot.`, { drone_id: drone }, { eta_min: 6 });
    this.emit("dispatch", { message: `Sent ${drone} to verify the hotspot.`, incident_id: id, drone_ids: [drone] });
    this.fly(drone, [[dock.lat, dock.lon], this.fire, [this.fire[0] + 0.0015, this.fire[1]], this.fire], this.current().durationMs * 0.9, "verifying");
    this.emit("decision", { run_id: run, summary: "Hotspot reported. A drone is verifying it. The prepare alert for Sierra Madre waits for approval." });
  }

  private enterConfirmed(): void {
    const id = this.incidentId;
    this.emit("incident", { id, lat: this.fire[0], lon: this.fire[1], status: "confirmed", confidence: 0.86 });
    const run = this.agentRun("Drone confirmed the fire at 0.86");
    this.spread = spreadField(this.fire, id);
    this.emit("spread", this.spread);
    this.step(run, "predict_spread", "Confirmed fire. The head reaches the north edge of Sierra Madre in about 2 hours 40 minutes.", { incident_id: id }, { cells: this.spread.cells.length });
    const routes = routesFor(id);
    for (const r of routes) this.emit("route", r);
    this.step(run, "plan_evacuation", "Routes planned: Sierra Madre to Arcadia High School (4.1 km), Altadena to Eaton Canyon hall (3.6 km).", { incident_id: id }, { routes: routes.length });
    const people = residents(this.fire, this.spread);
    this.emit("recipients", { incident_id: id, residents: people, simulated: true });
    const count = (tier: string) => people.filter((p) => p.tier === tier).length;
    const policy = "policy: drone-confirmed at 0.86";
    this.notify("evacuate", count("evacuate"), "Demo alert. Evacuate now. Take Baldwin Avenue south to Arcadia High School.", policy, "route-sierra-madre");
    this.notify("prepare", count("prepare"), "Demo alert. A wildfire is burning 3 km north of you. Be ready to leave on short notice.", policy);
    this.notify("watch", count("watch"), "Demo alert. A wildfire is burning in the San Gabriel foothills. No action needed now.", policy);
    this.step(run, "notify", `Sent alerts by tier: ${count("evacuate")} evacuate, ${count("prepare")} prepare, ${count("watch")} watch (SIM residents).`, { incident_id: id }, { sent: true });
    const held = `demo-approval-${id}`;
    if (useAppStore.getState().approvals[held]) {
      this.emit("decision", { run_id: run, approval_id: held, summary: "The held prepare alert is no longer needed: the confirmed fire sent alerts under policy." });
    }
    this.step(run, "log_decision", "Logged the decision.", {}, { ok: true });
    this.emit("decision", { run_id: run, summary: "Fire confirmed. Residents alerted by tier. Evacuation routes are open.", actions: ["Evacuate Sierra Madre north", "Dispatch suppression drones"] });
  }

  private enterSuppression(): void {
    this.suppressionStartMs = this.now();
    const run = this.agentRun("Operator dispatched suppression drones", "policy");
    const band = this.spread ? headBand(this.spread) : [];
    this.step(run, "dispatch_suppression", `Assigned 6 drones to the head band, ${band.length} cells 20 to 60 minutes out.`, { incident_id: this.incidentId }, { drones: 6, sorties_planned: 12 });
    this.emit("suppression", { incident_id: this.incidentId, sorties_done: 0, sorties_planned: 12, containment_pct: 0, treated_cells: [], simulated: true });
    this.flySuppression();
  }

  private flySuppression(): void {
    const band = this.spread ? headBand(this.spread) : [];
    const target: LatLon = band[Math.floor(band.length / 2)] ?? this.fire;
    DRONE_IDS.slice(0, 6).forEach((id, k) => {
      if (this.flights.has(id)) return;
      const dock = dockOf(id);
      const spot: LatLon = [target[0] + (k - 3) * 0.001, target[1] + (k % 2 ? 0.002 : -0.002)];
      this.fly(id, [[dock.lat, dock.lon], spot, [dock.lat, dock.lon]], 18 * MIN, "suppressing");
    });
  }

  private updateSuppression(elapsedMs: number): void {
    if (this.suppressionStartMs === null || !this.spread) return;
    const share = Math.min(1, elapsedMs / this.current().durationMs);
    const sorties = Math.min(12, Math.floor(share * 12.5));
    const containment = Math.round(Math.min(84, share * 92));
    const band = headBand(spreadField(this.fire, this.incidentId));
    const treated = band.slice(0, Math.round(band.length * Math.min(1, share * 1.2)));
    const key = `${sorties}:${containment}`;
    if (key !== this.lastSuppression) {
      this.lastSuppression = key;
      this.emit("suppression", { incident_id: this.incidentId, sorties_done: sorties, sorties_planned: 12, containment_pct: containment, treated_cells: treated, simulated: true });
      this.spread = spreadField(this.fire, this.incidentId, containment / 100);
      this.emit("spread", this.spread);
    }
    if (share < 0.85) this.flySuppression();
  }

  private enterContained(): void {
    this.emit("incident", { id: this.incidentId, lat: this.fire[0], lon: this.fire[1], status: "contained", confidence: 0.86 });
    const run = this.agentRun("Containment passed 80%", "policy");
    this.step(run, "log_decision", "Containment 84%. Predicted burn area down from 21 km² to 3.4 km².", {}, { containment_pct: 84 });
    this.emit("decision", { run_id: run, summary: "Fire contained at 84%. Keep evacuation orders until crews confirm. Next survey on schedule.", actions: ["Hold evacuation orders", "Survey again in 6 hours"] });
  }
}
