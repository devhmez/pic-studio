// Small transient messages at the bottom of the window (« Projet enregistré », « Fichier illisible »...).
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

/** A button on the message (« Annuler » after an import). */
export interface ToastAction {
  label: string;
  run(): void;
}

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
}

const toasts = createStore<{ items: Toast[] }>(() => ({ items: [] }));
let nextId = 1;

/** Show a message for a few seconds (errors and messages with a button stay longer). Any panel may call it. */
export function notify(message: string, kind: ToastKind = 'info', action?: ToastAction): void {
  const id = nextId++;
  toasts.setState((s) => ({ items: [...s.items.slice(-2), { id, message, kind, ...(action ? { action } : {}) }] }));
  setTimeout(() => dismissToast(id), kind === 'error' || action ? 7000 : 3500);
}

export function dismissToast(id: number): void {
  toasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

/** The messages on screen (for code outside React, and the tests). */
export function currentToasts(): readonly Toast[] {
  return toasts.getState().items;
}

export function useToasts(): Toast[] {
  return useStore(toasts, (s) => s.items);
}
