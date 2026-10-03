import type { Viewer } from "cesium";
import { create } from "zustand";
import type {
  Capture,
  EdgePlan,
  EmberEvent,
  Incident,
  KnownEvent,
  Notification,
  Report,
  SimClockState,
  Snapshot,
  Suppression,
  Survey,
  Zone,
  Zoned,
} from "../types/events";
import { useTelemetry } from "./telemetry";

export type FilterId = "normal" | "thermal" | "night" | "crt";

export const FILTERS: { id: FilterId; label: string; key: string }[] = [
  { id: "normal", label: "Normal", key: "1" },
  { id: "thermal", label: "Thermal", key: "2" },
  { id: "night", label: "Night", key: "3" },
  { id: "crt", label: "CRT", key: "4" },
];

export type LayerId =
  | "edgeServers"
  | "coverage"
  | "drones"
  | "surveyHeatmap"
  | "vulnerableSites"
  | "fireSpread"
  | "routes"
  | "recipients"
  | "suppression";

export const LAYERS: { id: LayerId; label: string; sim: boolean }[] = [
  { id: "edgeServers", label: "Edge servers", sim: false },
  { id: "coverage", label: "Coverage", sim: false },
  { id: "drones", label: "Drones", sim: true },
  { id: "surveyHeatmap", label: "Survey heatmap", sim: true },
  { id: "vulnerableSites", label: "Vulnerable sites", sim: true },
  { id: "fireSpread", label: "Fire spread", sim: true },
  { id: "routes", label: "Routes", sim: false },
  { id: "recipients", label: "Recipients", sim: true },
  { id: "suppression", label: "Suppression", sim: true },
];

export type AgentTab = "log" | "approvals" | "chat";

export type ConnectionState = "mock" | "connecting" | "open" | "reconnecting";

export type MapSourceId = "google" | "ion" | "osm";

export interface MapSourceInfo {
  id: MapSourceId;
  label: string;
  /** Why a fallback is active. Undefined when the preferred map loaded. */
  fallbackReason?: string;
}

/** Sim clock as last reported, plus the local time it was received. */
export interface SimClock {
  simTimeMs: number;
  speed: number;
  paused: boolean;
  syncedAtMs: number;
}

export function simNow(sim: SimClock, nowMs = Date.now()): number {
  return sim.paused ? sim.simTimeMs : sim.simTimeMs + (nowMs - sim.syncedAtMs) * sim.speed;
}

function toSimClock(s: SimClockState): SimClock {
  return { simTimeMs: Date.parse(s.sim_time), speed: s.speed, paused: s.paused, syncedAtMs: Date.now() };
}

const LOG_LIMIT = 500;

/** Agent-facing kinds shown in the Agent log. */
const LOG_KINDS = new Set([
  "log",
  "spread",
  "route",
  "dispatch",
  "alert",
  "approval_request",
  "decision",
]);

export interface AppState {
  viewer: Viewer | null;
  mapSource: MapSourceInfo | null;
  filter: FilterId;
  layers: Record<LayerId, boolean>;
  agentTab: AgentTab;
  connection: ConnectionState;

  sim: SimClock | null;
  zones: Record<string, Zone>;
  activeZoneId: string | null;
  edgePlans: Record<string, EdgePlan>;
  surveys: Record<string, Survey>;
  reports: Record<string, Report>;
  captures: Record<string, Zoned<Capture>>;
  incidents: Record<string, Zoned<Incident>>;
  notifications: Zoned<Notification>[];
  suppression: Record<string, Zoned<Suppression>>;
  approvals: Record<string, EmberEvent>;
  log: EmberEvent[];
  /** Latest spread and route payloads per zone, from the agent. */
  spread: Record<string, EmberEvent>;
  routes: Record<string, EmberEvent[]>;

  setViewer: (viewer: Viewer | null) => void;
  setMapSource: (info: MapSourceInfo) => void;
  setFilter: (filter: FilterId) => void;
  toggleLayer: (id: LayerId) => void;
  setAgentTab: (tab: AgentTab) => void;
  setConnection: (state: ConnectionState) => void;
  setActiveZone: (id: string | null) => void;
  applyEvent: (event: KnownEvent) => void;
}

const allLayersOn = Object.fromEntries(LAYERS.map((l) => [l.id, true])) as Record<LayerId, boolean>;

function zoned<P extends object>(event: EmberEvent<string, P>): Zoned<P> {
  return { ...event.payload, zone_id: event.zone_id };
}

function approvalId(event: EmberEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return String(payload.id ?? payload.approval_id ?? `${event.zone_id}:${event.ts}`);
}

function snapshotState(s: Snapshot): Partial<AppState> {
  const zones = Object.fromEntries(s.zones.map((z) => [z.id, z]));
  return {
    sim: toSimClock(s.sim),
    zones,
    edgePlans: s.edge_plans,
    surveys: s.surveys,
    reports: s.reports,
    captures: Object.fromEntries(s.captures.map((c) => [c.id, c])),
    incidents: Object.fromEntries(s.incidents.map((i) => [i.id, i])),
    notifications: s.notifications,
    suppression: Object.fromEntries(s.suppression.map((x) => [x.incident_id, x])),
    approvals: Object.fromEntries(s.approvals.map((a) => [approvalId(a), a])),
    log: s.log.slice(-LOG_LIMIT),
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  viewer: null,
  mapSource: null,
  filter: "normal",
  layers: allLayersOn,
  agentTab: "log",
  connection: "connecting",

  sim: null,
  zones: {},
  activeZoneId: null,
  edgePlans: {},
  surveys: {},
  reports: {},
  captures: {},
  incidents: {},
  notifications: [],
  suppression: {},
  approvals: {},
  log: [],
  spread: {},
  routes: {},

  setViewer: (viewer) => set({ viewer }),
  setMapSource: (mapSource) => set({ mapSource }),
  setFilter: (filter) => set({ filter }),
  toggleLayer: (id) => set((s) => ({ layers: { ...s.layers, [id]: !s.layers[id] } })),
  setAgentTab: (agentTab) => set({ agentTab }),
  setConnection: (connection) => set({ connection }),
  setActiveZone: (activeZoneId) => set({ activeZoneId }),

  applyEvent: (event) => {
    if (LOG_KINDS.has(event.kind)) {
      set((s) => ({ log: [...s.log.slice(-(LOG_LIMIT - 1)), event] }));
    }

    switch (event.kind) {
      case "snapshot": {
        const next = snapshotState(event.payload);
        useTelemetry.getState().replaceAll(event.payload.drones);
        const zoneIds = Object.keys(next.zones ?? {});
        const active = get().activeZoneId;
        set({
          ...next,
          activeZoneId: active && next.zones?.[active] ? active : (zoneIds[0] ?? null),
        });
        return;
      }
      case "sim":
        set({ sim: toSimClock(event.payload) });
        return;
      case "zone":
        set((s) => ({
          zones: { ...s.zones, [event.payload.id]: event.payload },
          activeZoneId: s.activeZoneId ?? event.payload.id,
        }));
        return;
      case "edge_plan":
        set((s) => ({ edgePlans: { ...s.edgePlans, [event.zone_id]: event.payload } }));
        return;
      case "drone":
        useTelemetry.getState().upsert(event.payload);
        return;
      case "survey":
        set((s) => ({ surveys: { ...s.surveys, [event.zone_id]: event.payload } }));
        return;
      case "capture":
        set((s) => ({ captures: { ...s.captures, [event.payload.id]: zoned(event) } }));
        return;
      case "report":
        set((s) => ({ reports: { ...s.reports, [event.zone_id]: event.payload } }));
        return;
      case "incident":
        set((s) => ({ incidents: { ...s.incidents, [event.payload.id]: zoned(event) } }));
        return;
      case "notification":
        set((s) => ({
          notifications: [...s.notifications.filter((n) => n.id !== event.payload.id), zoned(event)],
        }));
        return;
      case "suppression":
        set((s) => ({
          suppression: { ...s.suppression, [event.payload.incident_id]: zoned(event) },
        }));
        return;
      case "approval_request":
        set((s) => ({ approvals: { ...s.approvals, [approvalId(event)]: event } }));
        return;
      case "decision": {
        // A decision that resolves an approval removes it from the pending list.
        const resolved = (event.payload as Record<string, unknown>).approval_id;
        if (typeof resolved === "string") {
          set((s) => {
            const approvals = { ...s.approvals };
            delete approvals[resolved];
            return { approvals };
          });
        }
        return;
      }
      case "spread":
        set((s) => ({ spread: { ...s.spread, [event.zone_id]: event } }));
        return;
      case "route":
        set((s) => ({
          routes: { ...s.routes, [event.zone_id]: [...(s.routes[event.zone_id] ?? []), event] },
        }));
        return;
      case "log":
      case "dispatch":
      case "alert":
        return;
    }
  },
}));

export function selectActiveZone(s: AppState): Zone | null {
  return s.activeZoneId ? (s.zones[s.activeZoneId] ?? null) : null;
}
