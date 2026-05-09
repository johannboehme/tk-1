/**
 * In-memory store for transient job operations (sync, render).
 *
 * Replaces the persisted `job.status` / `job.progress` / `job.error`
 * lifecycle fields. Operations are inherently ephemeral — they belong
 * to the running tab, not to the project. On reload nothing is in
 * flight; the store starts empty. If an op was running when the tab
 * died, the project simply lacks the resulting data (no `videos[i].sync`,
 * no `lastRender`) and the user can re-trigger.
 *
 * Keep ops dumb: progress fields, error string, abort callback. The
 * lifecycle of an op is its presence in the store — orchestration code
 * sets it on start and clears it on terminal completion (or sets `error`
 * on failure and leaves it in place until the next attempt clears).
 */
import { create } from "zustand";

export interface SyncOpFileContext {
  name: string;
  size?: number;
  type?: string;
  sourceKind: "opfs" | "handle";
}

export interface SyncOpState {
  pct: number;
  stage: string;
  detail?: string;
  error?: string;
  /** Multi-line plaintext diagnostic report attached when an op fails.
   *  Carries browser, capability, file-in-flight, and original-error
   *  context so the user can copy-paste it back to us for triage. */
  errorReport?: string;
  /** The file currently being read/decoded, if any. Set as soon as the
   *  pipeline knows which asset it's working on so a failure mid-decode
   *  can report which file was in flight. */
  currentFile?: SyncOpFileContext;
}

export interface RenderOpState {
  pct: number;
  stage: string;
  framesDone?: number;
  framesTotal?: number;
  error?: string;
  /** True after a successful run: the result is persisted on the job
   *  (`lastRender`) and the screen can navigate away. Distinct from
   *  "absent op" so the RenderScreen can show "Done" briefly before
   *  the op clears. */
  done?: boolean;
}

export interface JobOps {
  sync?: SyncOpState;
  render?: RenderOpState;
}

interface OpsStore {
  ops: Record<string, JobOps>;

  // ─── sync ────────────────────────────────────────────────────────────
  startSyncOp: (jobId: string, init?: Partial<SyncOpState>) => void;
  updateSyncOp: (jobId: string, patch: Partial<SyncOpState>) => void;
  failSyncOp: (jobId: string, message: string, report?: string) => void;
  clearSyncOp: (jobId: string) => void;

  // ─── render ──────────────────────────────────────────────────────────
  startRenderOp: (jobId: string, init?: Partial<RenderOpState>) => void;
  updateRenderOp: (jobId: string, patch: Partial<RenderOpState>) => void;
  failRenderOp: (jobId: string, message: string) => void;
  finishRenderOp: (jobId: string) => void;
  clearRenderOp: (jobId: string) => void;
}

export const useOpsStore = create<OpsStore>((set) => ({
  ops: {},

  startSyncOp: (jobId, init) =>
    set((s) => ({
      ops: {
        ...s.ops,
        [jobId]: {
          ...s.ops[jobId],
          sync: { pct: 0, stage: "queued", ...init, error: undefined },
        },
      },
    })),

  updateSyncOp: (jobId, patch) =>
    set((s) => {
      const existing = s.ops[jobId]?.sync;
      if (!existing) return s;
      return {
        ops: {
          ...s.ops,
          [jobId]: { ...s.ops[jobId], sync: { ...existing, ...patch } },
        },
      };
    }),

  failSyncOp: (jobId, message, report) =>
    set((s) => {
      const existing = s.ops[jobId]?.sync;
      const base = existing ?? { pct: 100, stage: "failed" };
      return {
        ops: {
          ...s.ops,
          [jobId]: {
            ...s.ops[jobId],
            sync: { ...base, error: message, errorReport: report },
          },
        },
      };
    }),

  clearSyncOp: (jobId) =>
    set((s) => {
      const cur = s.ops[jobId];
      if (!cur?.sync) return s;
      const { sync: _drop, ...rest } = cur;
      const next = { ...s.ops };
      if (rest.render) next[jobId] = rest as JobOps;
      else delete next[jobId];
      return { ops: next };
    }),

  startRenderOp: (jobId, init) =>
    set((s) => ({
      ops: {
        ...s.ops,
        [jobId]: {
          ...s.ops[jobId],
          render: {
            pct: 0,
            stage: "render-prep",
            ...init,
            error: undefined,
            done: false,
          },
        },
      },
    })),

  updateRenderOp: (jobId, patch) =>
    set((s) => {
      const existing = s.ops[jobId]?.render;
      if (!existing) return s;
      return {
        ops: {
          ...s.ops,
          [jobId]: { ...s.ops[jobId], render: { ...existing, ...patch } },
        },
      };
    }),

  failRenderOp: (jobId, message) =>
    set((s) => {
      const existing = s.ops[jobId]?.render;
      const base = existing ?? { pct: 100, stage: "failed" };
      return {
        ops: {
          ...s.ops,
          [jobId]: { ...s.ops[jobId], render: { ...base, error: message } },
        },
      };
    }),

  finishRenderOp: (jobId) =>
    set((s) => {
      const existing = s.ops[jobId]?.render;
      if (!existing) return s;
      return {
        ops: {
          ...s.ops,
          [jobId]: {
            ...s.ops[jobId],
            render: { ...existing, pct: 100, stage: "rendered", done: true },
          },
        },
      };
    }),

  clearRenderOp: (jobId) =>
    set((s) => {
      const cur = s.ops[jobId];
      if (!cur?.render) return s;
      const { render: _drop, ...rest } = cur;
      const next = { ...s.ops };
      if (rest.sync) next[jobId] = rest as JobOps;
      else delete next[jobId];
      return { ops: next };
    }),
}));

/** Selector hook — read the sync op for a specific job. */
export function useSyncOp(jobId: string | null | undefined): SyncOpState | undefined {
  return useOpsStore((s) => (jobId ? s.ops[jobId]?.sync : undefined));
}

/** Selector hook — read the render op for a specific job. */
export function useRenderOp(jobId: string | null | undefined): RenderOpState | undefined {
  return useOpsStore((s) => (jobId ? s.ops[jobId]?.render : undefined));
}
