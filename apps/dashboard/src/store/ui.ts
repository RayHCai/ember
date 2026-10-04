import { create } from 'zustand';
import type { BlastArea, BlastAudience, BlastPriority } from '@ember/contracts';

export type OverlayMode = 'operator' | 'detection';

export type Pickable = 'server' | 'drone' | 'risk' | 'community' | 'drop' | 'safe' | 'station';

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
    area: BlastArea;
}

interface UiState {
    mode: OverlayMode;
    suggestions: boolean;
    selected: Picked | null;
    hover: Hover | null;
    agentOpen: boolean;
    /**
     * Open with a draft; `approve` jumps straight to the approval step. `pendingId` is a blast the
     * api holds for approval (drafted by the agent), approved instead of sent anew.
     */
    blast: { draft: BlastDraft | null; approve: boolean; pendingId: string | null } | null;
    gapsUntil: number;
    setMode: (mode: OverlayMode) => void;
    setSuggestions: (on: boolean) => void;
    select: (picked: Picked | null) => void;
    setHover: (hover: Hover | null) => void;
    setAgentOpen: (open: boolean) => void;
    openBlast: (draft?: BlastDraft | null, approve?: boolean, pendingId?: string | null) => void;
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
    blast: null,
    gapsUntil: 0,
    setMode: (mode) =>
        set((s) => ({ mode, suggestions: mode === 'operator' ? false : s.suggestions })),
    setSuggestions: (suggestions) =>
        set((s) => ({ suggestions, mode: suggestions ? 'detection' : s.mode })),
    select: (selected) => set({ selected }),
    setHover: (hover) => set({ hover }),
    setAgentOpen: (agentOpen) => set({ agentOpen }),
    openBlast: (draft = null, approve = false, pendingId = null) =>
        set({ blast: { draft, approve, pendingId } }),
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
            gapsUntil: 0,
        }),
}));
