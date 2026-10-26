import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  /** Milliseconds before it disappears; 0 keeps it until dismissed. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>()(() => ({ toasts: [] }));

let nextId = 1;

export function toast(input: Omit<Toast, 'id' | 'duration'> & { duration?: number }): number {
  const id = nextId++;
  const duration = input.duration ?? (input.kind === 'error' ? 6500 : 4500);
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { ...input, id, duration }] }));
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export const notify = {
  success: (title: string, body?: string) => toast({ kind: 'success', title, body }),
  error: (title: string, body?: string) => toast({ kind: 'error', title, body }),
  info: (title: string, body?: string) => toast({ kind: 'info', title, body }),
  warning: (title: string, body?: string) => toast({ kind: 'warning', title, body }),
};
