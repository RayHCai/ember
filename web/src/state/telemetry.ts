import { create } from "zustand";
import type { Drone } from "../types/events";

// Drone telemetry arrives several times a second per drone. It lives in its own
// store so position updates never re-render the main app. Globe layers read it
// with useTelemetry.subscribe; panels select only the fields they show.

interface TelemetryState {
  drones: Record<string, Drone>;
  upsert: (drone: Drone) => void;
  replaceAll: (drones: Drone[]) => void;
}

export const useTelemetry = create<TelemetryState>()((set) => ({
  drones: {},
  upsert: (drone) => set((s) => ({ drones: { ...s.drones, [drone.id]: drone } })),
  replaceAll: (drones) => set({ drones: Object.fromEntries(drones.map((d) => [d.id, d])) }),
}));
