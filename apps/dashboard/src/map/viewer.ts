import type { Viewer } from 'cesium';
import { create } from 'zustand';

export type MapSourceId = 'google' | 'ion' | 'osm';

export interface MapSourceInfo {
    id: MapSourceId;
    label: string;
    /** Why a fallback is active. Undefined when the preferred map loaded. */
    fallbackReason?: string;
}

interface MapState {
    viewer: Viewer | null;
    source: MapSourceInfo | null;
    setViewer: (viewer: Viewer | null) => void;
    setSource: (source: MapSourceInfo | null) => void;
}

/** The one Cesium viewer, shared by every page that shows the map. */
export const useMap = create<MapState>()((set) => ({
    viewer: null,
    source: null,
    setViewer: (viewer) => set({ viewer }),
    setSource: (source) => set({ source }),
}));
