/**
 * Imperative confirm-dialog helpers.
 *
 * Push a request onto a tiny zustand store, the `<ConfirmDialogHost>`
 * mounted in App.tsx renders the modal, the user's click resolves the
 * Promise. Callers just `await confirmDestructive({...})` — no JSX
 * boilerplate at the call site.
 *
 * Three flavours:
 *   - confirmDestructive: yes/no with a destructive-styled button.
 *   - chooseSplitReplacement: 4-way pick (A / B / Both / Cancel) for
 *     Triage's split-when-in-use case.
 *   - confirmMergeReplaceAll: yes/no specialised body for Triage's
 *     merge-when-isolated case.
 */
import { create } from "zustand";
import type { ReactNode } from "react";

export interface DestructiveRequest {
  kind: "destructive";
  id: number;
  title: string;
  body: ReactNode;
  destructiveLabel: string;
  cancelLabel: string;
  resolve: (confirmed: boolean) => void;
}

export type SplitReplacement = "a" | "b" | "both" | null;

export interface SplitRequest {
  kind: "split";
  id: number;
  title: string;
  body: ReactNode;
  resolve: (choice: SplitReplacement) => void;
}

export interface MergeRequest {
  kind: "merge";
  id: number;
  title: string;
  body: ReactNode;
  resolve: (confirmed: boolean) => void;
}

export type ConfirmRequest = DestructiveRequest | SplitRequest | MergeRequest;

interface ConfirmStore {
  requests: ConfirmRequest[];
  push: (req: ConfirmRequest) => void;
  resolve: (id: number, value: boolean | SplitReplacement) => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  requests: [],
  push: (req) => set((s) => ({ requests: [...s.requests, req] })),
  resolve: (id, value) => {
    const req = get().requests.find((r) => r.id === id);
    if (!req) return;
    if (req.kind === "split") {
      req.resolve(value as SplitReplacement);
    } else {
      req.resolve(value as boolean);
    }
    set((s) => ({ requests: s.requests.filter((r) => r.id !== id) }));
  },
}));

let nextId = 0;
function freshId(): number {
  nextId += 1;
  return nextId;
}

export function confirmDestructive(args: {
  title: string;
  body: ReactNode;
  destructiveLabel: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().push({
      kind: "destructive",
      id: freshId(),
      title: args.title,
      body: args.body,
      destructiveLabel: args.destructiveLabel,
      cancelLabel: args.cancelLabel ?? "Cancel",
      resolve,
    });
  });
}

export function chooseSplitReplacement(args: {
  title: string;
  body: ReactNode;
}): Promise<SplitReplacement> {
  return new Promise<SplitReplacement>((resolve) => {
    useConfirmStore.getState().push({
      kind: "split",
      id: freshId(),
      title: args.title,
      body: args.body,
      resolve,
    });
  });
}

export function confirmMergeReplaceAll(args: {
  title: string;
  body: ReactNode;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().push({
      kind: "merge",
      id: freshId(),
      title: args.title,
      body: args.body,
      resolve,
    });
  });
}
