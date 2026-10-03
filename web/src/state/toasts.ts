import { create } from "zustand";

export type ToastTone = "info" | "error";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function pushToast(message: string, tone: ToastTone = "info", action?: Toast["action"]): number {
  const id = useToasts.getState().push({ message, tone, action });
  if (!action) window.setTimeout(() => useToasts.getState().dismiss(id), tone === "error" ? 9000 : 5000);
  return id;
}
