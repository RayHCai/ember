import { create } from "zustand";
import type { Drone } from "../types/events";

// Drone telemetry arrives several times a second per drone. It lives in its own
// store so position updates never re-render the main app. Globe layers read it
// with useTelemetry.subscribe; panels select only the fields they show.

interface TelemetryState {
  drones: Record<string, Drone>;
  selectedId: string | null;
  upsert: (drone: Drone) => void;
  replaceAll: (drones: Drone[]) => void;
  /** Replace one zone's fleet (sent when its docks change). */
  replaceZone: (zoneId: string, drones: Drone[]) => void;
  removeZone: (zoneId: string) => void;
  select: (id: string | null) => void;
}

export const useTelemetry = create<TelemetryState>()((set) => ({
  drones: {},
  selectedId: null,
  upsert: (drone) => set((s) => ({ drones: { ...s.drones, [drone.id]: drone } })),
  replaceAll: (drones) => set({ drones: Object.fromEntries(drones.map((d) => [d.id, d])) }),
  replaceZone: (zoneId, drones) =>
    set((s) => ({
      drones: {
        ...Object.fromEntries(Object.entries(s.drones).filter(([, d]) => d.zone_id !== zoneId)),
        ...Object.fromEntries(drones.map((d) => [d.id, { ...d, zone_id: zoneId }])),
      },
    })),
  removeZone: (zoneId) =>
    set((s) => ({
      drones: Object.fromEntries(Object.entries(s.drones).filter(([, d]) => d.zone_id !== zoneId)),
      selectedId: s.selectedId && s.drones[s.selectedId]?.zone_id === zoneId ? null : s.selectedId,
    })),
  select: (selectedId) => set({ selectedId }),
}));
