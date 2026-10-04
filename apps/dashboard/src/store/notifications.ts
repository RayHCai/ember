import { create } from 'zustand';

export type Severity = 'info' | 'success' | 'warning' | 'critical';

export interface Notice {
    id: number;
    zoneId: string | null;
    zoneName: string | null;
    severity: Severity;
    title: string;
    body: string;
    at: number;
    read: boolean;
    /** Responders whose phones got a push for this event. */
    pushed: number;
}

interface NoticeState {
    notices: Notice[];
    /** Ids currently shown as toasts. */
    toasts: number[];
    push: (n: Omit<Notice, 'id' | 'at' | 'read' | 'pushed'> & { pushed?: number }) => number;
    dismissToast: (id: number) => void;
    markAllRead: () => void;
    clear: () => void;
}

let nextId = 1;

const TOAST_MS: Record<Severity, number> = {
    info: 5000,
    success: 5000,
    warning: 8000,
    critical: 11000,
};

export const useNotices = create<NoticeState>()((set, get) => ({
    notices: [],
    toasts: [],
    push: (n) => {
        const id = nextId++;
        const notice: Notice = { pushed: 0, ...n, id, at: Date.now(), read: false };
        set((s) => ({
            notices: [notice, ...s.notices].slice(0, 80),
            toasts: [...s.toasts.slice(-3), id],
        }));
        window.setTimeout(() => get().dismissToast(id), TOAST_MS[n.severity]);
        return id;
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t !== id) })),
    markAllRead: () => set((s) => ({ notices: s.notices.map((n) => ({ ...n, read: true })) })),
    clear: () => set({ notices: [], toasts: [] }),
}));

export function notify(
    severity: Severity,
    title: string,
    body = '',
    zone?: { id: string; name: string } | null,
    pushed = 0,
): number {
    return useNotices.getState().push({
        severity,
        title,
        body,
        zoneId: zone?.id ?? null,
        zoneName: zone?.name ?? null,
        pushed,
    });
}
