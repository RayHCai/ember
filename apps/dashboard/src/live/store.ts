import type { Incident, WatchZone as ApiWatchZone } from '@ember/contracts';
import { create } from 'zustand';
import type { LiveAlert } from './map';

/** `off`: this build has no api proxy. */
export type LiveStatus = 'off' | 'connecting' | 'online' | 'error';

/** One click on the map places a fire, or blocks or reopens a road. */
export type LiveTool = 'fire' | 'road' | null;

interface LiveState {
    status: LiveStatus;
    error: string | null;
    apiZone: ApiWatchZone | null;
    /** The dashboard's id for the live zone. */
    zoneId: string | null;
    lastSyncAt: number | null;
    incident: Incident | null;
    plan: { jobId: string; generatedAt: number; incidentId: string | null } | null;
    alerts: LiveAlert[];
    /** Approval ids with a decision on its way. */
    deciding: string[];
    tool: LiveTool;
    setTool: (tool: LiveTool) => void;
}

export const useLive = create<LiveState>()((set) => ({
    status: 'connecting',
    error: null,
    apiZone: null,
    zoneId: null,
    lastSyncAt: null,
    incident: null,
    plan: null,
    alerts: [],
    deciding: [],
    tool: null,
    setTool: (tool) => set({ tool }),
}));
