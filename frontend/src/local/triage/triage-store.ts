/**
 * Triage-Editor State.
 *
 * Tempo model: BPM is **song-global** (one number that all chunks
 * share when assembled), but each chunk has its own `audioStartMs` —
 * the master-audio time of its first onset, used to anchor that
 * chunk's bar grid in the timeline. Long-form sessions are not
 * recorded against a click; chunks start where the musician started
 * playing, which is rarely on the same beat-phase across chunks.
 *
 * The job-global BPM is computed as the most-common per-chunk BPM
 * during sync (see `pickGlobalBpm` in chunk-detect.ts) — whole-file
 * detection is unreliable on long-form sessions because the audio
 * contains independent musical fragments. The user can override the
 * global BPM via BpmReadout, and per chunk via the inspector's
 * octave-shift buttons (for the rare case the detector picked the
 * wrong octave on one chunk).
 */
import { create } from "zustand";
import type { BpmValue } from "../../editor/components/BpmReadoutView";
import type { SnapMode } from "../../editor/snap";
import type { Chunk, SilenceConfig, VideoAsset } from "../../storage/jobs-db";

export interface TriagePlayback {
  currentTime: number;
  isPlaying: boolean;
  /** Loop region (master-audio time, seconds). When set AND
   *  `loopEnabled` is true, the playback hook keeps the playhead
   *  between [start, end]. */
  loop: { start: number; end: number } | null;
  /** When false, focusing a chunk no longer arms loop playback —
   *  audio plays linearly through chunks. Default true. */
  loopEnabled: boolean;
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
  pcm: Float32Array | null;
  pcmSampleRate: number;
  envelope: Float32Array | null;
  envelopeHz: number;
  cams: VideoAsset[];

  // ─── Triage-specific ─────────────────────────────────────────────────
  chunks: Chunk[];
  silenceConfig: SilenceConfig;
  /** Current song-global BPM (possibly user-overridden). Null = no
   *  detection yet (analysis stage didn't produce a tempo). */
  jobBpm: BpmValue | null;
  /** Auto-detected BPM snapshot. Used as the reset target when the
   *  user has overridden. Null if detection failed. */
  detectedBpm: { value: number; confidence: number } | null;
  /** Time-signature numerator (= beats per bar). Default 4. */
  beatsPerBar: number;
  /** Anacrusis / pickup (beats), modulo `beatsPerBar`. Default 0. */
  barOffsetBeats: number;
  /** Beat-0 anchor in seconds (= editor's audioStart). Default 0. */
  beatPhaseS: number;
  /** Active snap mode for trim-handle drag. Default "1" (whole bar). */
  snapMode: SnapMode;
  focusedChunkId: string | null;
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
    jobBpm: BpmValue | null;
    detectedBpm: { value: number; confidence: number } | null;
    beatsPerBar: number;
    barOffsetBeats: number;
    beatPhaseS: number;
    snapMode: SnapMode;
    loopEnabled: boolean;
    pcm: Float32Array;
    pcmSampleRate: number;
    envelope: Float32Array;
    envelopeHz: number;
  }): void;
  reset(): void;

  setChunks(chunks: Chunk[]): void;
  updateChunk(id: string, patch: Partial<Chunk>): void;
  /** Extend or shrink a chunk by a number of bars at the song-global
   *  BPM. Sign convention: positive `barsBack` pushes startMs back
   *  (longer chunk on the left); positive `barsFwd` pushes endMs
   *  forward. */
  extendChunkBars(id: string, barsBack: number, barsFwd: number): void;
  setSilenceConfig(config: SilenceConfig): void;

  // BPM / time-signature.
  setJobBpm(bpm: BpmValue): void;
  resetBpmToDetected(): void;
  setBeatsPerBar(n: number): void;
  setSnapMode(m: SnapMode): void;

  focusChunk(id: string | null): void;
  acceptFocused(autoAdvance?: boolean): void;
  rejectFocused(autoAdvance?: boolean): void;
  /** Move focus to the previous/next chunk (chronological). */
  focusRelative(delta: -1 | 1): void;

  setSelectedCamId(id: string | null): void;
  nudgeCamSyncOverride(camId: string, deltaMs: number): void;

  // Playback actions (mirror editor shape).
  setPlaying(p: boolean): void;
  seek(t: number): void;
  setLoop(loop: TriagePlayback["loop"]): void;
  setLoopEnabled(enabled: boolean): void;
  tickTime(t: number): void;

  // View actions.
  setZoom(z: number): void;
  setScrollX(x: number): void;
}

const INITIAL_PLAYBACK: TriagePlayback = {
  currentTime: 0,
  isPlaying: false,
  loop: null,
  loopEnabled: true,
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
  jobBpm: null,
  detectedBpm: null,
  beatsPerBar: 4,
  barOffsetBeats: 0,
  beatPhaseS: 0,
  snapMode: "1",
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
      jobBpm: args.jobBpm,
      detectedBpm: args.detectedBpm,
      beatsPerBar: args.beatsPerBar,
      barOffsetBeats: args.barOffsetBeats,
      beatPhaseS: args.beatPhaseS,
      snapMode: args.snapMode,
      pcm: args.pcm,
      pcmSampleRate: args.pcmSampleRate,
      envelope: args.envelope,
      envelopeHz: args.envelopeHz,
      selectedCamId: args.cams[0]?.id ?? null,
      focusedChunkId: null,
      playback: { ...INITIAL_PLAYBACK, loopEnabled: args.loopEnabled },
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
      jobBpm: null,
      detectedBpm: null,
      beatsPerBar: 4,
      barOffsetBeats: 0,
      beatPhaseS: 0,
      snapMode: "1",
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

  extendChunkBars(id, barsBack, barsFwd) {
    const s = get();
    const chunk = s.chunks.find((c) => c.id === id);
    if (!chunk) return;
    const bpm = effectiveChunkBpm(chunk, s.jobBpm?.value ?? null);
    if (bpm <= 0) return;
    const msPerBar = (60_000 / bpm) * s.beatsPerBar;
    const nextStart = Math.max(0, Math.round(chunk.startMs - barsBack * msPerBar));
    const nextEnd = Math.max(
      nextStart + 100,
      Math.min(s.audioDuration * 1000, Math.round(chunk.endMs + barsFwd * msPerBar)),
    );
    s.updateChunk(id, { startMs: nextStart, endMs: nextEnd, trimMode: "bar" });
    if (s.focusedChunkId === id) {
      set({
        playback: {
          ...s.playback,
          loop: { start: nextStart / 1000, end: nextEnd / 1000 },
        },
      });
    }
  },

  setJobBpm(bpm) {
    set({ jobBpm: bpm });
  },

  resetBpmToDetected() {
    const s = get();
    if (!s.detectedBpm) return;
    set({
      jobBpm: {
        value: s.detectedBpm.value,
        confidence: s.detectedBpm.confidence,
        manualOverride: false,
      },
    });
  },

  setBeatsPerBar(n) {
    if (!Number.isFinite(n) || n < 1) return;
    set({ beatsPerBar: Math.round(n) });
  },

  setSnapMode(m) {
    set({ snapMode: m });
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
        // Loop arms only when the user wants it. Off → linear playback,
        // playhead jumps to chunk start but doesn't bounce.
        loop: s.playback.loopEnabled
          ? { start: chunk.startMs / 1000, end: chunk.endMs / 1000 }
          : null,
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

  nudgeCamSyncOverride(camId, deltaMs) {
    set((s) => ({
      cams: s.cams.map((c) =>
        c.id === camId
          ? { ...c, syncOverrideMs: (c.syncOverrideMs ?? 0) + deltaMs }
          : c,
      ),
    }));
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

  setLoopEnabled(enabled) {
    set((s) => {
      // Turning loop off while a chunk is focused clears the active
      // loop region so playback continues linearly. Turning it back on
      // re-arms loop on the focused chunk if any.
      if (!enabled) {
        return { playback: { ...s.playback, loopEnabled: false, loop: null } };
      }
      const focused = s.focusedChunkId
        ? s.chunks.find((c) => c.id === s.focusedChunkId)
        : null;
      return {
        playback: {
          ...s.playback,
          loopEnabled: true,
          loop: focused
            ? { start: focused.startMs / 1000, end: focused.endMs / 1000 }
            : null,
        },
      };
    });
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

/** Resolve the BPM that drives a chunk's bar grid. Per-chunk values
 *  win when set (octave-shift on a detected per-chunk BPM); otherwise
 *  fall back to the song-global `jobBpm`. Returns 0 when no BPM is
 *  available anywhere — callers should suppress bar rendering in that
 *  case. */
export function effectiveChunkBpm(
  chunk: { detectedBpm?: number; bpmOctaveShift: -1 | 0 | 1; effectiveBpm: number },
  jobBpm: number | null,
): number {
  // Octave-shift only applies on top of a per-chunk detected BPM. If
  // the chunk had no detection, fall through to the job-global.
  if (chunk.detectedBpm && chunk.detectedBpm > 0) {
    return chunk.detectedBpm * Math.pow(2, chunk.bpmOctaveShift);
  }
  if (jobBpm && jobBpm > 0) return jobBpm;
  return chunk.effectiveBpm > 0 ? chunk.effectiveBpm : 0;
}

/** Resolve the master-audio time (seconds) that anchors a chunk's
 *  bar grid. Defaults to the chunk's start when no onset was
 *  detected. */
export function chunkBeatPhaseS(chunk: {
  startMs: number;
  audioStartMs?: number;
}): number {
  return (chunk.audioStartMs ?? chunk.startMs) / 1000;
}
