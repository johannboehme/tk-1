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
import { analyzeAudio } from "../render/audio-analysis/analyze";
import type { Chunk, SilenceConfig, VideoAsset } from "../../storage/jobs-db";
import { snapChunkEndToBar } from "./chunk-bar-grid";

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
  /** True while the master-audio PCM is being decoded in the
   *  background (hasCached path). Conform waits on this flag so it
   *  doesn't bail with "no audio loaded" right after the user opens
   *  the page from cache. */
  pcmDecoding: boolean;
  /** Set when the background PCM decode failed — propagates to
   *  Conform so the inspector can surface the actual cause instead
   *  of a generic "no audio loaded" message. */
  pcmDecodeError: string | null;
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
  /** Minimum chunk length (in bars at the global tempo) for a chunk to
   *  remain accepted. 0 = no filter. Set via the DetectionPanel
   *  dropdown — short blips below the threshold get auto-rejected so
   *  the arrangement isn't polluted with sample-test fragments. */
  minChunkBars: number;
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
    minChunkBars: number;
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
  /** Manually slice a chunk in two at the given master-audio time
   *  (ms). Both halves inherit the user's accept-flag and BPM
   *  metadata, and each computes its own `audioStartMs` as the bar
   *  boundary of the original grid that lies inside its range — so
   *  splitting a coherent take preserves the rhythm in both halves
   *  without re-detecting phase. Returns the new ID of the right
   *  half, or null if the cut would be degenerate (≤50 ms from
   *  either edge or outside the chunk). The left half keeps the
   *  original ID so persistent references survive. */
  splitChunkAt(id: string, atMs: number): string | null;
  /** Re-fit a chunk's bar-grid phase from its current audio range,
   *  holding the song-global BPM as the period. Snaps `startMs` and
   *  `endMs` onto bar boundaries of the new grid so two conformed
   *  chunks line up seamlessly when assembled. BPM fields are not
   *  touched — BPM is global. Returns a status string the inspector
   *  surfaces inline:
   *    - "ok"        — bounds re-fitted, snapshot stashed
   *    - "unchanged" — already in phase + on-grid; nothing to do
   *    - "no-chunk"  — id not found
   *    - "no-bpm"    — global BPM not resolved yet
   *    - "too-short" — no PCM loaded
   *    - "no-beats"  — analyzer + onset fallback both came up empty */
  conformChunk(
    id: string,
  ): "ok" | "unchanged" | "no-chunk" | "no-bpm" | "too-short" | "no-beats";
  /** Restore a chunk to its pre-conform state. No-op when there's no
   *  snapshot (chunk has never been conformed, or has been edited
   *  since). */
  revertConform(id: string): void;
  /** Merge a focused chunk with its chronological neighbour. The
   *  combined chunk wins audioStartMs from whichever half started
   *  first (preserves musical phase) and inherits accept = a OR b
   *  (kept-wins). The neighbour is removed; the focused chunk's ID
   *  is preserved so refs/IDs stay stable. */
  joinChunks(id: string, direction: "prev" | "next"): void;
  /** Drop a fresh chunk into a silence gap at the current playhead.
   *  Defaults to one bar (or 4s if no BPM yet); trims to the
   *  remaining gap when the default would overlap a neighbour.
   *  Returns the new chunk ID, or null if the playhead is inside
   *  an existing chunk. */
  insertChunkAtPlayhead(): string | null;
  /** Restore the chunk to its detection snapshot (or, for manually
   *  created chunks, to the values it was seeded with). No-op when
   *  the chunk has no snapshot yet — legacy data, see schema. */
  resetChunk(id: string): void;
  setSilenceConfig(config: SilenceConfig): void;

  // BPM / time-signature.
  setJobBpm(bpm: BpmValue): void;
  resetBpmToDetected(): void;
  setBeatsPerBar(n: number): void;
  setSnapMode(m: SnapMode): void;
  /** Set the min-bars filter. When > 0, all chunks shorter than that
   *  many bars at the song-global tempo are immediately marked
   *  accepted=false. Subsequent re-detections re-apply the filter. */
  setMinChunkBars(bars: number): void;

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
  pcmDecoding: false,
  pcmDecodeError: null,
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
  minChunkBars: 0,
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
      minChunkBars: args.minChunkBars,
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
      pcmDecoding: false,
      pcmDecodeError: null,
      envelope: null,
      cams: [],
      chunks: [],
      jobBpm: null,
      detectedBpm: null,
      beatsPerBar: 4,
      barOffsetBeats: 0,
      beatPhaseS: 0,
      snapMode: "1",
      minChunkBars: 0,
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
    // Snap the current edges to the chunk's own bar grid (anchored at
    // its audio-start onset) BEFORE stepping. Without this, repeatedly
    // hitting "⟸ in" or "out ⟹" on a boundary that started off-grid
    // would just translate the offset further along — the chunk would
    // never line up to its bars. With it, every click lands on the
    // grid; the first click also corrects any pre-existing drift.
    const anchorMs = chunk.audioStartMs ?? chunk.startMs;
    const startBarsFromAnchor = Math.round((chunk.startMs - anchorMs) / msPerBar);
    const endBarsFromAnchor = Math.round((chunk.endMs - anchorMs) / msPerBar);
    const nextStartBars = startBarsFromAnchor - barsBack;
    const nextEndBars = endBarsFromAnchor + barsFwd;
    const nextStart = Math.max(0, Math.round(anchorMs + nextStartBars * msPerBar));
    const nextEnd = Math.max(
      nextStart + 100,
      Math.min(
        s.audioDuration * 1000,
        Math.round(anchorMs + nextEndBars * msPerBar),
      ),
    );
    // Trim invalidates any conform snapshot — its bounds belonged to the
    // pre-trim range and would restore stale values.
    s.updateChunk(id, {
      startMs: nextStart,
      endMs: nextEnd,
      trimMode: "bar",
      preConformSnapshot: undefined,
    });
    if (s.focusedChunkId === id) {
      set({
        playback: {
          ...s.playback,
          loop: { start: nextStart / 1000, end: nextEnd / 1000 },
        },
      });
    }
  },

  splitChunkAt(id, atMs) {
    const s = get();
    const chunk = s.chunks.find((c) => c.id === id);
    if (!chunk) return null;
    const minGap = 50;
    if (atMs <= chunk.startMs + minGap || atMs >= chunk.endMs - minGap) {
      return null;
    }
    const splitMs = Math.round(atMs);
    const newId = `${chunk.id}-r-${Date.now().toString(36)}`;
    // Both halves keep the **same bar grid** as the pre-split chunk —
    // the user expects "split here" to slice a coherent take into two
    // coherent pieces, not to throw away the rhythm. Each half stores
    // its own anchor (a bar boundary of the original grid that lies
    // inside the half's range) so chunks remain self-contained in the
    // data model.
    //
    // Cold-start fallback (no global BPM yet): preserve the legacy
    // behaviour of keeping the original anchor on the left and using
    // the click point on the right. With no msPerBar to project onto,
    // there's nothing better to compute.
    const originalAnchor = chunk.audioStartMs ?? chunk.startMs;
    const hasGrid = chunk.effectiveBpm > 0 && chunk.beatsPerBar > 0;
    const leftAnchor = hasGrid
      ? anchorInRange(originalAnchor, chunk.effectiveBpm, chunk.beatsPerBar, chunk.startMs)
      : originalAnchor;
    const rightAnchor = hasGrid
      ? anchorInRange(originalAnchor, chunk.effectiveBpm, chunk.beatsPerBar, splitMs)
      : splitMs;
    // Each half snapshots its own current bounds as its origin — Reset
    // pulls back to "right after the split", not to the pre-split chunk
    // (which no longer exists). Predictable: split, edit one side, hit
    // Reset, you get the post-split version back.
    const left: Chunk = {
      ...chunk,
      endMs: splitMs,
      audioStartMs: leftAnchor,
      trimMode: "free",
      originalStartMs: chunk.startMs,
      originalEndMs: splitMs,
      originalAudioStartMs: leftAnchor,
      // Snapshot was scoped to the pre-split chunk; meaningless on the
      // halves. Drop it so the inspector's Original button doesn't
      // surface a stale undo target.
      preConformSnapshot: undefined,
    };
    const right: Chunk = {
      ...chunk,
      id: newId,
      startMs: splitMs,
      audioStartMs: rightAnchor,
      trimMode: "free",
      originalStartMs: splitMs,
      originalEndMs: chunk.endMs,
      originalAudioStartMs: rightAnchor,
      preConformSnapshot: undefined,
    };
    const others = s.chunks.filter((c) => c.id !== id);
    set({ chunks: [...others, left, right] });
    if (s.focusedChunkId === id) {
      const next = useTriageStore.getState();
      next.focusChunk(newId);
    }
    return newId;
  },

  conformChunk(id) {
    const s = get();
    const chunk = s.chunks.find((c) => c.id === id);
    if (!chunk) return "no-chunk";
    const bpm = effectiveChunkBpm(chunk, s.jobBpm?.value ?? null);
    if (!bpm || bpm <= 0) return "no-bpm";
    const beatsPerBar = chunk.beatsPerBar > 0 ? chunk.beatsPerBar : s.beatsPerBar;
    const pcm = s.pcm;
    if (!pcm || pcm.length === 0) return "too-short";
    const sampleRate = s.pcmSampleRate;
    const startSample = Math.max(0, Math.floor((chunk.startMs / 1000) * sampleRate));
    const endSample = Math.min(pcm.length, Math.ceil((chunk.endMs / 1000) * sampleRate));
    if (endSample <= startSample) return "too-short";
    const slice = pcm.subarray(startSample, endSample);
    const existingAnchor = chunk.audioStartMs ?? chunk.startMs;

    // Idempotence: if this chunk was already Conformed (its bounds
    // were stashed as a snapshot), trust the existing anchor and just
    // re-snap endMs to whole bars. The analyzer's STFT frame
    // quantization (~46 ms wobble around frame centers) means
    // successive analyses on shifted slices can keep "discovering" a
    // ~46 ms gap, eating into the chunk a sliver at a time. Snapshots
    // are cleared on split/join/extend/reset, so a freshly-edited
    // chunk falls into the analyse path again as expected.
    let newAnchorMs: number;
    let newStartMs: number;
    if (chunk.preConformSnapshot != null) {
      newAnchorMs = existingAnchor;
      newStartMs = chunk.startMs;
    } else {
      const analysis = analyzeAudio(slice, sampleRate);
      // `audioStartS` is the first significant onset (with 30 ms
      // backoff if the first 300 ms is absolute silence) — same value
      // initial detection seeds `audioStartMs` from. We deliberately
      // don't use the LS-fit `tempo.phase`: the DP beat-tracker can
      // pick beat 2 or 3 as its chain start, shifting the LS phase by
      // a beat and snapping startMs PAST the first onset, eating into
      // the first beat of music.
      const candidateAnchor = chunk.startMs + analysis.audioStartS * 1000;
      newAnchorMs = anchorInRange(candidateAnchor, bpm, beatsPerBar, chunk.startMs);
      // Trim leading silence: if the analyzer detected a silent intro
      // inside the slice, advance startMs to where music begins (= the
      // anchor). Otherwise leave startMs alone — the chunk already
      // starts on audio and we'd be cutting into actual music.
      const hasSilentIntro = analysis.audioStartS > 0;
      newStartMs = hasSilentIntro ? Math.round(newAnchorMs) : chunk.startMs;
    }
    const newEndMs = snapChunkEndToBar(
      newStartMs,
      chunk.endMs,
      newAnchorMs,
      bpm,
      beatsPerBar,
    );

    // Truly idempotent: same anchor, same edges → no-op. Don't touch
    // state, don't stash a snapshot (there's nothing to revert).
    const POSITION_TOL_MS = 1;
    const samePosition =
      Math.abs(newStartMs - chunk.startMs) <= POSITION_TOL_MS &&
      Math.abs(newEndMs - chunk.endMs) <= POSITION_TOL_MS &&
      Math.abs(newAnchorMs - existingAnchor) <= POSITION_TOL_MS;
    if (samePosition) return "unchanged";

    set({
      chunks: s.chunks.map((c) =>
        c.id === id
          ? {
              ...c,
              startMs: newStartMs,
              endMs: newEndMs,
              audioStartMs: newAnchorMs,
              trimMode: "bar",
              // Stash the pre-conform bounds so the user can revert
              // via the "Original" button next to Conform. Replaces
              // any prior snapshot — only the most recent conform is
              // undoable.
              preConformSnapshot: {
                startMs: chunk.startMs,
                endMs: chunk.endMs,
                audioStartMs: chunk.audioStartMs,
              },
            }
          : c,
      ),
    });
    return "ok";
  },

  revertConform(id) {
    const s = get();
    const chunk = s.chunks.find((c) => c.id === id);
    if (!chunk) return;
    const snap = chunk.preConformSnapshot;
    if (!snap) return;
    set({
      chunks: s.chunks.map((c) =>
        c.id === id
          ? {
              ...c,
              startMs: snap.startMs,
              endMs: snap.endMs,
              audioStartMs: snap.audioStartMs,
              preConformSnapshot: undefined,
            }
          : c,
      ),
    });
  },

  joinChunks(id, direction) {
    const s = get();
    const sorted = [...s.chunks].sort((a, b) => a.startMs - b.startMs);
    const idx = sorted.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const neighbourIdx = direction === "prev" ? idx - 1 : idx + 1;
    if (neighbourIdx < 0 || neighbourIdx >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[neighbourIdx];
    const earlier = a.startMs <= b.startMs ? a : b;
    const later = earlier === a ? b : a;
    const mergedStart = earlier.startMs;
    const mergedEnd = later.endMs;
    const mergedAudioStart = earlier.audioStartMs ?? earlier.startMs;
    const merged: Chunk = {
      ...a,
      startMs: mergedStart,
      endMs: mergedEnd,
      audioStartMs: mergedAudioStart,
      accepted: a.accepted || b.accepted,
      detectedBpm: durationWeightedBpm(a, b),
      trimMode: "free",
      originalStartMs: mergedStart,
      originalEndMs: mergedEnd,
      originalAudioStartMs: mergedAudioStart,
      // Snapshots from either half were scoped to a smaller range;
      // discard.
      preConformSnapshot: undefined,
    };
    const remaining = s.chunks.filter((c) => c.id !== a.id && c.id !== b.id);
    set({ chunks: [...remaining, merged] });
    const next = useTriageStore.getState();
    next.focusChunk(merged.id);
  },

  insertChunkAtPlayhead() {
    const s = get();
    const atMs = Math.round(s.playback.currentTime * 1000);
    // Reject when the playhead sits inside an existing chunk — this
    // action is for filling silence gaps only. Use Split instead.
    const inside = s.chunks.find(
      (c) => atMs > c.startMs && atMs < c.endMs,
    );
    if (inside) return null;
    const sorted = [...s.chunks].sort((a, b) => a.startMs - b.startMs);
    const nextNeighbour = sorted.find((c) => c.startMs >= atMs);
    const gapEnd = Math.min(
      s.audioDuration * 1000,
      nextNeighbour?.startMs ?? s.audioDuration * 1000,
    );
    if (gapEnd <= atMs + 100) return null;
    const bpm = s.jobBpm?.value ?? 0;
    const desiredMs = bpm > 0
      ? Math.round((60_000 / bpm) * s.beatsPerBar)
      : 4000;
    const endMs = Math.min(gapEnd, atMs + desiredMs);
    const newId = `manual-${Date.now().toString(36)}`;
    const chunk: Chunk = {
      id: newId,
      startMs: atMs,
      endMs,
      audioStartMs: atMs,
      bpmOctaveShift: 0,
      effectiveBpm: bpm,
      beatsPerBar: s.beatsPerBar,
      accepted: true,
      trimMode: "free",
      originalStartMs: atMs,
      originalEndMs: endMs,
      originalAudioStartMs: atMs,
    };
    set({ chunks: [...s.chunks, chunk] });
    const next = useTriageStore.getState();
    next.focusChunk(newId);
    return newId;
  },

  resetChunk(id) {
    const s = get();
    const chunk = s.chunks.find((c) => c.id === id);
    if (!chunk) return;
    if (chunk.originalStartMs == null || chunk.originalEndMs == null) return;
    s.updateChunk(id, {
      startMs: chunk.originalStartMs,
      endMs: chunk.originalEndMs,
      audioStartMs: chunk.originalAudioStartMs ?? chunk.originalStartMs,
      trimMode: "auto",
      // Reset goes back to detection-time bounds; any pre-conform
      // snapshot was scoped to bounds that no longer exist.
      preConformSnapshot: undefined,
    });
    if (s.focusedChunkId === id && s.playback.loopEnabled) {
      set({
        playback: {
          ...s.playback,
          loop: {
            start: chunk.originalStartMs / 1000,
            end: chunk.originalEndMs / 1000,
          },
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

  setMinChunkBars(bars) {
    const safe = Number.isFinite(bars) ? Math.max(0, bars) : 0;
    set({ minChunkBars: safe });
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
    // Prev/Next walk only through EFFECTIVELY-accepted chunks — i.e.
    // user-kept AND passing the active min-bars filter. Filter-hidden
    // and user-dropped chunks both get skipped. If the focused chunk
    // is itself excluded (focused via click then dropped, or below
    // the filter threshold), find the nearest accepted chunk in the
    // requested direction by master-time.
    const jobBpmValue = s.jobBpm?.value ?? null;
    const accepted = [...s.chunks]
      .filter((c) =>
        isChunkEffectivelyAccepted(c, s.minChunkBars, jobBpmValue, s.beatsPerBar),
      )
      .sort((a, b) => a.startMs - b.startMs);
    if (accepted.length === 0) return;
    const focused = s.focusedChunkId
      ? s.chunks.find((c) => c.id === s.focusedChunkId) ?? null
      : null;

    let nextIdx: number;
    if (!focused) {
      nextIdx = delta > 0 ? 0 : accepted.length - 1;
    } else {
      const idxInAccepted = accepted.findIndex((c) => c.id === focused.id);
      if (idxInAccepted >= 0) {
        nextIdx = Math.max(
          0,
          Math.min(accepted.length - 1, idxInAccepted + delta),
        );
        if (nextIdx === idxInAccepted) return;
      } else if (delta > 0) {
        const found = accepted.findIndex((c) => c.startMs > focused.startMs);
        nextIdx = found >= 0 ? found : accepted.length - 1;
      } else {
        let prev = -1;
        for (let i = 0; i < accepted.length; i++) {
          if (accepted[i].startMs < focused.startMs) prev = i;
          else break;
        }
        nextIdx = prev >= 0 ? prev : 0;
      }
    }
    s.focusChunk(accepted[nextIdx].id);
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

/** When two chunks merge, prefer keeping a meaningful detected tempo
 *  rather than dropping it. Picks the longer chunk's BPM if both have
 *  one; falls back to whichever side has a BPM at all. */
function durationWeightedBpm(
  a: { startMs: number; endMs: number; detectedBpm?: number },
  b: { startMs: number; endMs: number; detectedBpm?: number },
): number | undefined {
  if (!a.detectedBpm && !b.detectedBpm) return undefined;
  if (a.detectedBpm && !b.detectedBpm) return a.detectedBpm;
  if (b.detectedBpm && !a.detectedBpm) return b.detectedBpm;
  const aLen = a.endMs - a.startMs;
  const bLen = b.endMs - b.startMs;
  return aLen >= bLen ? a.detectedBpm : b.detectedBpm;
}

/** Resolve the BPM that drives a chunk's bar grid. Song-global `jobBpm`
 *  wins; the per-chunk detected value is just a fallback for cases
 *  where a global hasn't been determined yet (e.g. detection failed).
 *  Returns 0 when no BPM is available anywhere — callers should
 *  suppress bar rendering in that case. */
export function effectiveChunkBpm(
  chunk: { detectedBpm?: number; effectiveBpm: number },
  jobBpm: number | null,
): number {
  if (jobBpm && jobBpm > 0) return jobBpm;
  if (chunk.detectedBpm && chunk.detectedBpm > 0) return chunk.detectedBpm;
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

/** Find the bar boundary of a grid `originalAnchor + N * msPerBar` that
 *  lies at or after `boundaryMs`. Used by `splitChunkAt` to give each
 *  half its own self-contained anchor on the same grid as the pre-split
 *  chunk, and by `conformChunk` to land the freshly-detected phase on
 *  the earliest in-range bar boundary.
 *
 *  Returns `boundaryMs` itself when BPM is unknown (cold start before
 *  global BPM resolves). The result is always within
 *  `[boundaryMs, boundaryMs + msPerBar)`. */
export function anchorInRange(
  originalAnchor: number,
  bpm: number | undefined,
  beatsPerBar: number,
  boundaryMs: number,
): number {
  if (!bpm || bpm <= 0 || !Number.isFinite(bpm)) return boundaryMs;
  if (!beatsPerBar || beatsPerBar <= 0) return boundaryMs;
  const msPerBar = (60_000 / bpm) * beatsPerBar;
  if (!Number.isFinite(msPerBar) || msPerBar <= 0) return boundaryMs;
  const k = Math.ceil((boundaryMs - originalAnchor) / msPerBar);
  return Math.round(originalAnchor + k * msPerBar);
}

/** Pure predicate: does this chunk meet the active min-bars filter?
 *  When the filter is off (or there's no BPM yet to size a bar), the
 *  filter is a no-op and every chunk passes.
 *
 *  Filter is a VIEW-LAYER concern. It's read where chunks are
 *  rendered or counted, never mutates `chunk.accepted` — that flag
 *  belongs to the user's manual Keep/Drop decision and must survive
 *  filter changes round-trip (off → 1 bar → off restores the
 *  original state). */
export function chunkPassesFilter(
  chunk: { startMs: number; endMs: number },
  minBars: number,
  jobBpm: number | null,
  beatsPerBar: number,
): boolean {
  if (minBars <= 0 || !jobBpm || jobBpm <= 0 || beatsPerBar <= 0) return true;
  const msPerBar = (60_000 / jobBpm) * beatsPerBar;
  return chunk.endMs - chunk.startMs >= minBars * msPerBar;
}

/** Convenience: a chunk is "effectively accepted" iff the user kept
 *  it AND it passes the active min-bars filter. */
export function isChunkEffectivelyAccepted(
  chunk: Chunk,
  minBars: number,
  jobBpm: number | null,
  beatsPerBar: number,
): boolean {
  return (
    chunk.accepted && chunkPassesFilter(chunk, minBars, jobBpm, beatsPerBar)
  );
}
