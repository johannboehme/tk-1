/**
 * Triage-Editor State.
 *
 * Lives separate from the Editor store because the concepts only loosely
 * overlap — Triage's "focused chunk" isn't an Editor "selected clip",
 * the chunk-list isn't a clip-list, and the per-chunk BPM isn't the
 * job-global BPM. We do mirror the Editor's playback shape (currentTime,
 * loop, isPlaying) and zoom shape (zoom, scrollX) so a future shared
 * audio-master hook can drive both.
 */
import { create } from "zustand";
import type { Chunk, SilenceConfig, VideoAsset } from "../../storage/jobs-db";

export interface TriagePlayback {
  currentTime: number;
  isPlaying: boolean;
  /** Loop region (master-audio time, seconds). When set, the playback
   *  hook keeps the playhead between [start, end]. Triage uses this
   *  for chunk-loop. */
  loop: { start: number; end: number } | null;
}

export interface TriageView {
  /** Zoom factor. 1 = full duration fits. >1 = zoomed in. */
  zoom: number;
  /** Scroll offset in seconds (left edge of visible region). */
  scrollX: number;
}

export interface TriageState {
  // ─── Inputs / cached data ─────────────────────────────────────────────
  jobId: string | null;
  audioDuration: number;
  /** Decoded master-audio PCM at PCM_SAMPLE_RATE — held for live
   *  re-runs of silence detection on slider tweaks. Cleared when the
   *  page unmounts. */
  pcm: Float32Array | null;
  pcmSampleRate: number;
  envelope: Float32Array | null;
  envelopeHz: number;
  /** Per-cam metadata (filename, color, sync). Mirror of the job's
   *  videos[] filtered to video assets. */
  cams: VideoAsset[];

  // ─── Triage-specific ─────────────────────────────────────────────────
  chunks: Chunk[];
  silenceConfig: SilenceConfig;
  /** ID of the focused chunk for inspector + loop playback. Null = no
   *  focus, transport plays linearly. */
  focusedChunkId: string | null;
  /** ID of the cam being previewed + nudged. Null = the lead cam (cam-1
   *  by convention) is shown. */
  selectedCamId: string | null;

  // ─── Playback / view ──────────────────────────────────────────────────
  playback: TriagePlayback;
  view: TriageView;

  // ─── Actions ──────────────────────────────────────────────────────────
  initFromJob(args: {
    jobId: string;
    audioDuration: number;
    cams: VideoAsset[];
    chunks: Chunk[];
    silenceConfig: SilenceConfig;
    pcm: Float32Array;
    pcmSampleRate: number;
    envelope: Float32Array;
    envelopeHz: number;
  }): void;
  reset(): void;

  setChunks(chunks: Chunk[]): void;
  updateChunk(id: string, patch: Partial<Chunk>): void;
  setSilenceConfig(config: SilenceConfig): void;
  focusChunk(id: string | null): void;
  acceptFocused(autoAdvance?: boolean): void;
  rejectFocused(autoAdvance?: boolean): void;
  /** Move focus to the previous/next chunk (chronological). */
  focusRelative(delta: -1 | 1): void;

  setSelectedCamId(id: string | null): void;

  // Playback actions (mirror editor shape).
  setPlaying(p: boolean): void;
  seek(t: number): void;
  setLoop(loop: TriagePlayback["loop"]): void;
  /** Transport advances currentTime — bumped from the audio-master
   *  hook every RAF tick. */
  tickTime(t: number): void;

  // View actions.
  setZoom(z: number): void;
  setScrollX(x: number): void;
}

const INITIAL_PLAYBACK: TriagePlayback = {
  currentTime: 0,
  isPlaying: false,
  loop: null,
};

const INITIAL_VIEW: TriageView = {
  zoom: 1,
  scrollX: 0,
};

export const DEFAULT_SILENCE_CONFIG_STORE: SilenceConfig = {
  thresholdDb: -50,
  minPauseMs: 1500,
};

export const useTriageStore = create<TriageState>((set, get) => ({
  jobId: null,
  audioDuration: 0,
  pcm: null,
  pcmSampleRate: 22050,
  envelope: null,
  envelopeHz: 10,
  cams: [],

  chunks: [],
  silenceConfig: DEFAULT_SILENCE_CONFIG_STORE,
  focusedChunkId: null,
  selectedCamId: null,

  playback: INITIAL_PLAYBACK,
  view: INITIAL_VIEW,

  initFromJob(args) {
    set({
      jobId: args.jobId,
      audioDuration: args.audioDuration,
      cams: args.cams,
      chunks: args.chunks,
      silenceConfig: args.silenceConfig,
      pcm: args.pcm,
      pcmSampleRate: args.pcmSampleRate,
      envelope: args.envelope,
      envelopeHz: args.envelopeHz,
      // Default to the first cam for preview. The user can switch
      // via the SyncPatchPanel.
      selectedCamId: args.cams[0]?.id ?? null,
      // Reset transient UI state.
      focusedChunkId: null,
      playback: INITIAL_PLAYBACK,
      view: INITIAL_VIEW,
    });
  },

  reset() {
    set({
      jobId: null,
      audioDuration: 0,
      pcm: null,
      envelope: null,
      cams: [],
      chunks: [],
      focusedChunkId: null,
      selectedCamId: null,
      playback: INITIAL_PLAYBACK,
      view: INITIAL_VIEW,
    });
  },

  setChunks(chunks) {
    set({ chunks });
  },

  updateChunk(id, patch) {
    set((s) => ({
      chunks: s.chunks.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  },

  setSilenceConfig(config) {
    set({ silenceConfig: config });
  },

  focusChunk(id) {
    const s = get();
    if (id === null) {
      set({ focusedChunkId: null, playback: { ...s.playback, loop: null } });
      return;
    }
    const chunk = s.chunks.find((c) => c.id === id);
    if (!chunk) return;
    set({
      focusedChunkId: id,
      playback: {
        ...s.playback,
        loop: { start: chunk.startMs / 1000, end: chunk.endMs / 1000 },
        // Snap playhead to chunk start when focusing — feels like
        // "tap chunk to hear it".
        currentTime: chunk.startMs / 1000,
      },
    });
  },

  acceptFocused(autoAdvance = true) {
    const s = get();
    if (!s.focusedChunkId) return;
    s.updateChunk(s.focusedChunkId, { accepted: true });
    if (autoAdvance) s.focusRelative(1);
  },

  rejectFocused(autoAdvance = true) {
    const s = get();
    if (!s.focusedChunkId) return;
    s.updateChunk(s.focusedChunkId, { accepted: false });
    if (autoAdvance) s.focusRelative(1);
  },

  focusRelative(delta) {
    const s = get();
    if (s.chunks.length === 0) return;
    const sorted = [...s.chunks].sort((a, b) => a.startMs - b.startMs);
    const currentIdx = s.focusedChunkId
      ? sorted.findIndex((c) => c.id === s.focusedChunkId)
      : -1;
    const nextIdx = Math.max(
      0,
      Math.min(sorted.length - 1, currentIdx + delta),
    );
    if (nextIdx === currentIdx) return;
    s.focusChunk(sorted[nextIdx].id);
  },

  setSelectedCamId(id) {
    set({ selectedCamId: id });
  },

  setPlaying(p) {
    set((s) => ({ playback: { ...s.playback, isPlaying: p } }));
  },

  seek(t) {
    set((s) => ({
      playback: {
        ...s.playback,
        currentTime: Math.max(0, Math.min(s.audioDuration, t)),
      },
    }));
  },

  setLoop(loop) {
    set((s) => ({ playback: { ...s.playback, loop } }));
  },

  tickTime(t) {
    set((s) => ({ playback: { ...s.playback, currentTime: t } }));
  },

  setZoom(z) {
    set((s) => ({
      view: { ...s.view, zoom: Math.max(1, Math.min(500, z)) },
    }));
  },

  setScrollX(x) {
    set((s) => ({ view: { ...s.view, scrollX: Math.max(0, x) } }));
  },
}));
