/**
 * Reel store — the active reel being assembled on `/reel/:id`.
 *
 * Loads from / debounce-saves to the `reels` IndexedDB store. Holds the
 * ordered members (project references + per-member framing), the common
 * output format, and the render lifecycle. Distinct from the Library list
 * of reels, which reads `jobsDb.listReels()` directly.
 */
import { create } from "zustand";
import {
  jobsDb,
  type ReelRecord,
  type ReelMemberRecord,
} from "../../storage/jobs-db";
import type { ExportSpec, ViewportTransform } from "../../editor/types";
import {
  resolveCamAssetUrl,
  runReelRender,
  cancelReelRender,
  reelOutputPath,
} from "../jobs";
import { opfs } from "../../storage/opfs";

const DEFAULT_VIEWPORT: ViewportTransform = { scale: 1, x: 0, y: 0 };

export const DEFAULT_REEL_EXPORT: ExportSpec = {
  preset: "web",
  resolution: { w: 1920, h: 1080 },
  aspectRatio: "16:9",
  resolutionLongSide: 1920,
  video_codec: "h264",
  audio_codec: "aac",
};

export interface ReelMember {
  memberId: string;
  jobId: string;
  title: string;
  fullDurationS: number;
  posterUrl: string | null;
  viewport: ViewportTransform;
  trimInS: number;
  trimOutS: number;
  /** Referenced job (or its rendered source) is gone. */
  missing: boolean;
}

export interface ReelRenderUiState {
  status: "idle" | "running" | "done" | "error";
  pct: number;
  stage: string;
  resultUrl: string | null;
  error: string | null;
}

interface ReelState {
  reelId: string | null;
  title: string | null;
  members: ReelMember[];
  selectedMemberId: string | null;
  exportSpec: ExportSpec;
  render: ReelRenderUiState;

  loadReel(id: string): Promise<void>;
  reset(): void;
  addMembers(jobIds: string[]): Promise<void>;
  removeMember(memberId: string): void;
  reorderMember(from: number, to: number): void;
  moveMember(memberId: string, delta: number): void;
  selectMember(memberId: string | null): void;
  setMemberViewport(memberId: string, patch: Partial<ViewportTransform>): void;
  resetMemberViewport(memberId: string): void;
  setExport(patch: Partial<ExportSpec>): void;
  setTitle(title: string): void;
  startRender(): Promise<void>;
  cancelRender(): Promise<void>;
  totalDurationS(): number;
  stage(): { w: number; h: number };
}

const IDLE_RENDER: ReelRenderUiState = {
  status: "idle",
  pct: 0,
  stage: "",
  resultUrl: null,
  error: null,
};

function stageOf(spec: ExportSpec): { w: number; h: number } {
  const r = spec.resolution;
  if (r && typeof r === "object") return { w: r.w, h: r.h };
  return { w: 1920, h: 1080 };
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Create + persist a new reel from the given projects (in order). Returns
 *  the new reel id for navigation. */
export async function createReel(jobIds: string[]): Promise<string> {
  const id = uid() + uid();
  const members: ReelMemberRecord[] = jobIds.map((jobId) => ({
    memberId: uid(),
    jobId,
  }));
  const record: ReelRecord = {
    id,
    title: null,
    createdAt: Date.now(),
    members,
    stage: stageOf(DEFAULT_REEL_EXPORT),
    exportSpec: DEFAULT_REEL_EXPORT,
  };
  await jobsDb.saveReel(record);
  return id;
}

/** Delete a reel record + its rendered OPFS output. */
export async function deleteReel(id: string): Promise<void> {
  await jobsDb.deleteReel(id);
  await opfs.deletePath(`reels/${id}`).catch(() => undefined);
}

async function hydrateMember(rec: ReelMemberRecord): Promise<ReelMember> {
  const job = await jobsDb.getJob(rec.jobId);
  const base: ReelMember = {
    memberId: rec.memberId,
    jobId: rec.jobId,
    title: job?.title || rec.jobId.slice(0, 8),
    fullDurationS: job?.durationS ?? 0,
    posterUrl: null,
    viewport: rec.viewport ?? { ...DEFAULT_VIEWPORT },
    trimInS: rec.trimInS ?? 0,
    trimOutS: rec.trimOutS ?? (job?.durationS ?? 0),
    missing: !job || !(job.videos && job.videos.length > 0),
  };
  if (job?.videos?.length) {
    const cam0 = job.videos[0].id;
    base.posterUrl =
      (await resolveCamAssetUrl(rec.jobId, cam0, "frames").catch(() => null)) ??
      (await resolveCamAssetUrl(rec.jobId, cam0, "video").catch(() => null));
  }
  return base;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useReelStore = create<ReelState>((set, get) => {
  function schedulePersist() {
    const id = get().reelId;
    if (!id) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const s = get();
      if (!s.reelId) return;
      const members: ReelMemberRecord[] = s.members.map((m) => ({
        memberId: m.memberId,
        jobId: m.jobId,
        viewport: m.viewport,
        trimInS: m.trimInS,
        trimOutS: m.trimOutS,
      }));
      void jobsDb
        .updateReel(s.reelId, {
          title: s.title,
          members,
          exportSpec: s.exportSpec,
          stage: stageOf(s.exportSpec),
        })
        .catch(() => undefined);
    }, 300);
  }

  return {
    reelId: null,
    title: null,
    members: [],
    selectedMemberId: null,
    exportSpec: DEFAULT_REEL_EXPORT,
    render: { ...IDLE_RENDER },

    async loadReel(id) {
      const rec = await jobsDb.getReel(id);
      if (!rec) {
        set({ reelId: id, title: null, members: [], selectedMemberId: null });
        return;
      }
      const members = await Promise.all(rec.members.map(hydrateMember));
      const spec = (rec.exportSpec as ExportSpec | undefined) ?? DEFAULT_REEL_EXPORT;
      set({
        reelId: id,
        title: rec.title,
        members,
        exportSpec: spec,
        selectedMemberId: members[0]?.memberId ?? null,
        render: { ...IDLE_RENDER },
      });
    },

    reset() {
      set({
        reelId: null,
        title: null,
        members: [],
        selectedMemberId: null,
        exportSpec: DEFAULT_REEL_EXPORT,
        render: { ...IDLE_RENDER },
      });
    },

    async addMembers(jobIds) {
      const fresh = await Promise.all(
        jobIds.map((jobId) => hydrateMember({ memberId: uid(), jobId })),
      );
      set({ members: [...get().members, ...fresh] });
      schedulePersist();
    },

    removeMember(memberId) {
      set({
        members: get().members.filter((m) => m.memberId !== memberId),
        selectedMemberId:
          get().selectedMemberId === memberId ? null : get().selectedMemberId,
      });
      schedulePersist();
    },

    reorderMember(from, to) {
      const members = [...get().members];
      if (from < 0 || from >= members.length || to < 0 || to >= members.length) {
        return;
      }
      const [moved] = members.splice(from, 1);
      members.splice(to, 0, moved);
      set({ members });
      schedulePersist();
    },

    moveMember(memberId, delta) {
      const members = get().members;
      const idx = members.findIndex((m) => m.memberId === memberId);
      if (idx < 0) return;
      get().reorderMember(idx, idx + delta);
    },

    selectMember(memberId) {
      set({ selectedMemberId: memberId });
    },

    setMemberViewport(memberId, patch) {
      set({
        members: get().members.map((m) =>
          m.memberId === memberId
            ? { ...m, viewport: { ...m.viewport, ...patch } }
            : m,
        ),
      });
      schedulePersist();
    },

    resetMemberViewport(memberId) {
      set({
        members: get().members.map((m) =>
          m.memberId === memberId
            ? { ...m, viewport: { ...DEFAULT_VIEWPORT } }
            : m,
        ),
      });
      schedulePersist();
    },

    setExport(patch) {
      set({ exportSpec: { ...get().exportSpec, ...patch } });
      schedulePersist();
    },

    setTitle(title) {
      set({ title });
      schedulePersist();
    },

    async startRender() {
      const s = get();
      if (!s.reelId || s.render.status === "running") return;
      const renderable = s.members.filter((m) => !m.missing);
      if (renderable.length === 0) {
        set({
          render: {
            ...IDLE_RENDER,
            status: "error",
            error: "No renderable projects in this reel.",
          },
        });
        return;
      }
      if (s.render.resultUrl) URL.revokeObjectURL(s.render.resultUrl);
      set({
        render: { status: "running", pct: 0, stage: "render-prep", resultUrl: null, error: null },
      });
      try {
        const stage = stageOf(s.exportSpec);
        const result = await runReelRender({
          reelId: s.reelId,
          members: renderable.map((m) => ({ jobId: m.jobId, viewport: m.viewport })),
          stage,
          videoCodec: s.exportSpec.video_codec ?? "h264",
          audioCodec: s.exportSpec.audio_codec ?? "aac",
          videoBitrateBps: s.exportSpec.video_bitrate_kbps
            ? s.exportSpec.video_bitrate_kbps * 1000
            : undefined,
          audioBitrateBps: s.exportSpec.audio_bitrate_kbps
            ? s.exportSpec.audio_bitrate_kbps * 1000
            : undefined,
          onProgress: (p) =>
            set({ render: { ...get().render, pct: p.pct, stage: p.stage } }),
        });
        await jobsDb
          .updateReel(s.reelId, {
            lastRender: { completedAt: Date.now(), outputBytes: result.outputBytes },
          })
          .catch(() => undefined);
        const url = await resolveJobReelUrl(s.reelId);
        set({
          render: { status: "done", pct: 100, stage: "rendered", resultUrl: url, error: null },
        });
      } catch (err) {
        set({
          render: {
            ...IDLE_RENDER,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },

    async cancelRender() {
      const id = get().reelId;
      if (id) await cancelReelRender(id);
      set({ render: { ...IDLE_RENDER } });
    },

    totalDurationS() {
      return get().members.reduce(
        (a, m) => a + Math.max(0, m.trimOutS - m.trimInS),
        0,
      );
    },

    stage() {
      return stageOf(get().exportSpec);
    },
  };
});

/** Object URL for a reel's rendered output, or null if absent. */
async function resolveJobReelUrl(reelId: string): Promise<string | null> {
  const path = reelOutputPath(reelId);
  if (!(await opfs.exists(path))) return null;
  return opfs.objectUrl(path);
}
