import type { Viewer } from "cesium";
import { create } from "zustand";
import type {
  Capture,
  EdgePlan,
  EdgeServer,
  EmberEvent,
  Incident,
  KnownEvent,
  LatLon,
  Notification,
  Report,
  Shelter,
  SimClockState,
  Snapshot,
  Suppression,
  Survey,
  Zone,
  ZoneMap,
  Zoned,
} from "../types/events";
import { useObserved } from "./observed";
import { useTelemetry } from "./telemetry";

export type FilterId = "normal" | "thermal" | "night" | "crt";

export const FILTERS: { id: FilterId; label: string; key: string }[] = [
  { id: "normal", label: "Normal", key: "1" },
  { id: "thermal", label: "Thermal", key: "2" },
  { id: "night", label: "Night", key: "3" },
  { id: "crt", label: "CRT", key: "4" },
];

export type LayerId =
  | "places"
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
  { id: "places", label: "Roads and places", sim: false },
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

/** The globe interaction that is active, if any. */
export type Tool =
  | { kind: "draw-zone" }
  | { kind: "edit-edge"; zoneId: string }
  | { kind: "edit-shelters"; zoneId: string };

export interface EdgeDraft {
  zoneId: string;
  servers: EdgeServer[];
}

/** A zone outline being drawn. */
export interface ZoneDraft {
  points: LatLon[];
  closed: boolean;
}

export interface ShelterDraft {
  zoneId: string;
  shelters: Shelter[];
}

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

  tool: Tool | null;
  zoneDraft: ZoneDraft | null;
  edgeDraft: EdgeDraft | null;
  shelterDraft: ShelterDraft | null;

  sim: SimClock | null;
  zones: Record<string, Zone>;
  zoneMaps: Record<string, ZoneMap>;
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
  setTool: (tool: Tool | null) => void;
  setZoneDraft: (draft: ZoneDraft | null) => void;
  setEdgeDraft: (draft: EdgeDraft | null) => void;
  setShelterDraft: (draft: ShelterDraft | null) => void;
  /** Change the sim clock locally (mock mode has no server to ask). */
  setSimLocal: (change: { speed?: number; paused?: boolean }) => void;
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
    zoneMaps: s.zone_maps ?? {},
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

  tool: null,
  zoneDraft: null,
  edgeDraft: null,
  shelterDraft: null,

  sim: null,
  zones: {},
  zoneMaps: {},
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
  setTool: (tool) => set({ tool }),
  setZoneDraft: (zoneDraft) => set({ zoneDraft }),
  setEdgeDraft: (edgeDraft) => set({ edgeDraft }),
  setShelterDraft: (shelterDraft) => set({ shelterDraft }),
  setSimLocal: (change) =>
    set((s) => {
      if (!s.sim) return {};
      const now = Date.now();
      return {
        sim: {
          simTimeMs: simNow(s.sim, now),
          syncedAtMs: now,
          speed: change.speed ?? s.sim.speed,
          paused: change.paused ?? s.sim.paused,
        },
      };
    }),

  applyEvent: (event) => {
    if (LOG_KINDS.has(event.kind)) {
      set((s) => ({ log: [...s.log.slice(-(LOG_LIMIT - 1)), event] }));
    }

    switch (event.kind) {
      case "snapshot": {
        const next = snapshotState(event.payload);
        useTelemetry.getState().replaceAll(event.payload.drones);
        for (const [zoneId, sc] of Object.entries(event.payload.survey_cells ?? {})) {
          useObserved.getState().add(zoneId, sc.survey_id, sc.cells, true);
        }
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
      case "zone_map":
        set((s) => ({ zoneMaps: { ...s.zoneMaps, [event.zone_id]: event.payload } }));
        return;
      case "zone_removed":
        useTelemetry.getState().removeZone(event.zone_id);
        useObserved.getState().removeZone(event.zone_id);
        set((s) => {
          const id = event.zone_id;
          const without = <T,>(table: Record<string, T>) => {
            const next = { ...table };
            delete next[id];
            return next;
          };
          const zones = without(s.zones);
          const editing = s.tool && "zoneId" in s.tool && s.tool.zoneId === id;
          return {
            zones,
            zoneMaps: without(s.zoneMaps),
            edgePlans: without(s.edgePlans),
            surveys: without(s.surveys),
            reports: without(s.reports),
            activeZoneId: s.activeZoneId === id ? (Object.keys(zones)[0] ?? null) : s.activeZoneId,
            tool: editing ? null : s.tool,
            edgeDraft: s.edgeDraft?.zoneId === id ? null : s.edgeDraft,
            shelterDraft: s.shelterDraft?.zoneId === id ? null : s.shelterDraft,
          };
        });
        return;
      case "edge_plan": {
        const pending = event.payload.servers.some((srv) => srv.status === "pending");
        set((s) => ({
          edgePlans: { ...s.edgePlans, [event.zone_id]: event.payload },
          // A new suggestion becomes the working copy; a deployment ends editing.
          edgeDraft: pending
            ? { zoneId: event.zone_id, servers: event.payload.servers }
            : s.edgeDraft?.zoneId === event.zone_id
              ? null
              : s.edgeDraft,
        }));
        return;
      }
      case "drone":
        useTelemetry.getState().upsert({ ...event.payload, zone_id: event.zone_id });
        return;
      case "fleet":
        useTelemetry.getState().replaceZone(event.zone_id, event.payload.drones);
        return;
      case "survey_cells":
        useObserved.getState().add(event.zone_id, event.payload.survey_id, event.payload.cells, event.payload.reset);
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

/** Edge servers to show for a zone: the working copy while editing, else the plan. */
export function selectZoneServers(s: AppState, zoneId: string | null): EdgeServer[] {
  if (!zoneId) return EMPTY_SERVERS;
  if (s.edgeDraft?.zoneId === zoneId) return s.edgeDraft.servers;
  return s.edgePlans[zoneId]?.servers ?? EMPTY_SERVERS;
}

const EMPTY_SERVERS: EdgeServer[] = [];
