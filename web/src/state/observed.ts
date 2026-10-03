import { create } from "zustand";

// Cells observed by the running survey, per zone. Updates arrive many times a
// second, so this is kept out of the main store; the survey layer subscribes.

export interface ObservedCells {
  surveyId: string;
  cells: Set<number>;
  /** Bumped on every change so subscribers can tell. */
  version: number;
}

interface ObservedState {
  zones: Record<string, ObservedCells>;
  add: (zoneId: string, surveyId: string, cells: number[], reset?: boolean) => void;
  removeZone: (zoneId: string) => void;
  clear: () => void;
}

export const useObserved = create<ObservedState>()((set) => ({
  zones: {},
  add: (zoneId, surveyId, cells, reset) =>
    set((s) => {
      const prev = s.zones[zoneId];
      const fresh = reset || !prev || prev.surveyId !== surveyId;
      const next: ObservedCells = fresh
        ? { surveyId, cells: new Set(cells), version: (prev?.version ?? 0) + 1 }
        : { surveyId, cells: prev.cells, version: prev.version + 1 };
      if (!fresh) for (const c of cells) next.cells.add(c);
      return { zones: { ...s.zones, [zoneId]: next } };
    }),
  clear: () => set({ zones: {} }),
  removeZone: (zoneId) =>
    set((s) => {
      const zones = { ...s.zones };
      delete zones[zoneId];
      return { zones };
    }),
}));
