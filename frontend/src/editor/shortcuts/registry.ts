/**
 * Global keyboard-shortcut registry (cheat-sheet metadata).
 *
 * Entries are registered by the keymap (`bindShortcut` /
 * `useGlobalShortcut` with a `help` field) together with the binding
 * that implements the behavior, so the HelpOverlay renders an
 * always-current list of what each key does — behavior and
 * documentation cannot drift apart.
 *
 * Storage is a flat ordered list keyed by stable `id`. Re-registering
 * the same id replaces the entry in place (StrictMode mounts a hook
 * twice; we don't want phantom duplicates).
 */
import { create } from "zustand";
import type { ReactNode } from "react";

export interface ShortcutMeta {
  /** Stable identifier — re-registering with the same id replaces the entry. */
  id: string;
  /** Visible key labels, e.g. ["Space"], ["1"–"9"], ["F"]. */
  keys: string[];
  /** English, present-tense description of what the shortcut does. */
  description: string;
  /** Optional inline SVG icon (16×16 line-style, currentColor). */
  icon?: ReactNode;
  /** Optional grouping label, e.g. "Transport", "Cameras", "FX". */
  group?: string;
}

interface RegistryState {
  shortcuts: ShortcutMeta[];
}

export const useShortcutRegistry = create<RegistryState>(() => ({
  shortcuts: [],
}));

/**
 * Register a shortcut. Returns an `unregister` callback — call it from
 * the same effect's cleanup to remove the entry on unmount.
 */
export function registerShortcut(meta: ShortcutMeta): () => void {
  useShortcutRegistry.setState((state) => {
    const existingIdx = state.shortcuts.findIndex((s) => s.id === meta.id);
    if (existingIdx === -1) {
      return { shortcuts: [...state.shortcuts, meta] };
    }
    const next = state.shortcuts.slice();
    next[existingIdx] = meta;
    return { shortcuts: next };
  });
  return () => {
    useShortcutRegistry.setState((state) => ({
      shortcuts: state.shortcuts.filter((s) => s.id !== meta.id),
    }));
  };
}
