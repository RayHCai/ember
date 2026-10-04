import { create } from 'zustand';
import type { BlastAudience, BlastPriority } from '../sim/types';

export type OverlayMode = 'operator' | 'detection';

export type Pickable = 'server' | 'drone' | 'report' | 'community' | 'drop' | 'safe';

export interface Picked {
    kind: Pickable;
    id: string;
}

export interface Hover extends Picked {
    x: number;
    y: number;
}

export interface BlastDraft {
    audience: BlastAudience;
    priority: BlastPriority;
    title: string;
    body: string;
    area: 'zone' | 'near_fire';
}

interface UiState {
    mode: OverlayMode;
    suggestions: boolean;
    selected: Picked | null;
    hover: Hover | null;
    agentOpen: boolean;
    responderOpen: boolean;
    /** Open with a draft; `approve` jumps straight to the approval step. */
    blast: { draft: BlastDraft | null; approve: boolean } | null;
    gapsUntil: number;
    setMode: (mode: OverlayMode) => void;
    setSuggestions: (on: boolean) => void;
    select: (picked: Picked | null) => void;
    setHover: (hover: Hover | null) => void;
    setAgentOpen: (open: boolean) => void;
    setResponderOpen: (open: boolean) => void;
    openBlast: (draft?: BlastDraft | null, approve?: boolean) => void;
    closeBlast: () => void;
    showGaps: (ms?: number) => void;
    /** Each zone opens on its own default view. */
    resetForZone: (hasDetections: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
    mode: 'operator',
    suggestions: false,
    selected: null,
    hover: null,
    agentOpen: false,
    responderOpen: false,
    blast: null,
    gapsUntil: 0,
    setMode: (mode) =>
        set((s) => ({ mode, suggestions: mode === 'operator' ? false : s.suggestions })),
    setSuggestions: (suggestions) =>
        set((s) => ({ suggestions, mode: suggestions ? 'detection' : s.mode })),
    select: (selected) => set({ selected }),
    setHover: (hover) => set({ hover }),
    setAgentOpen: (agentOpen) => set({ agentOpen }),
    setResponderOpen: (responderOpen) => set({ responderOpen }),
    openBlast: (draft = null, approve = false) => set({ blast: { draft, approve } }),
    closeBlast: () => set({ blast: null }),
    showGaps: (ms = 9000) =>
        set({ gapsUntil: Date.now() + ms, mode: 'operator', suggestions: false }),
    resetForZone: (hasDetections) =>
        set({
            mode: hasDetections ? 'detection' : 'operator',
            suggestions: false,
            selected: null,
            hover: null,
            blast: null,
            responderOpen: false,
            gapsUntil: 0,
        }),
}));
