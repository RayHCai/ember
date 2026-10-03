import { create } from "zustand";

type AppState = {
  globeReady: boolean;
  setGlobeReady: (ready: boolean) => void;
};

export const useAppStore = create<AppState>()((set) => ({
  globeReady: false,
  setGlobeReady: (globeReady) => set({ globeReady }),
}));
