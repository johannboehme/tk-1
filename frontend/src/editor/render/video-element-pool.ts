/**
 * Pool of hidden `<video>` elements driving the new compositor.
 *
 * Replaces the per-cam `CamCanvas` mount: instead of N React-managed
 * `<video>`s stacked inside the OutputFrameBox with CSS transforms and
 * visibility toggles, the new preview pipeline mounts N `<video>`s
 * OFF the visual layout (`display:none` sibling) and the backend
 * samples whichever cam is active as a GPU texture per RAF.
 *
 * Lifecycle (per cam):
 *   - Mount `<video>` with `muted`, `playsInline`, `preload="auto"`,
 *     `crossOrigin="anonymous"` — same attrs as today's CamCanvas.
 *   - Decoder warmup: one-shot `play()` → `pause()` when the first
 *     frame is decoded (`HAVE_CURRENT_DATA`). Pushes a frame into the
 *     decoder so the user's first cam-switch already has a real
 *     picture, and the H.264/AV1/VP9 decoder is spun up before they
 *     touch a key.
 *   - On `loadedmetadata` / `resize`: report `videoWidth`/`Height` via
 *     the supplied `onDimsReport` callback (post-rotation already
 *     applied by the browser).
 *
 * Per-tick sync (drives by `syncAll(masterT, isPlaying)` from the
 * runtime's RAF):
 *   - Seek-drift correction: hard `currentTime = sourceT` when more
 *     than 100 ms off (browsers handle ~50 ms gracefully).
 *   - Play/pause based on whether the source-time is inside the cam's
 *     `[0, sourceDurationS)` range AND the master clock is playing.
 *
 * Same math as the old CamCanvas — just lifted into a class so a single
 * RAF owns N cams instead of one effect-binding per cam.
 */
import type { VideoClip } from "../types";

export interface VideoCam {
  clip: VideoClip;
  videoUrl: string;
}

export interface VideoElementPoolOptions {
  cams: readonly VideoCam[];
  /** Reports the cam's post-rotation natural pixel dims into whatever
   *  store / mechanism owns the output-frame bbox. Called once per cam
   *  on first metadata, and again on `resize` events. */
  onDimsReport(clipId: string, width: number, height: number): void;
  /** Optional injection point for tests — defaults to
   *  `document.createElement("video")`. */
  createElement?(): HTMLVideoElement;
}

/** Per-cam slot — the `<video>` plus its source-duration for
 *  range-checks. Source-time targets come from the per-frame
 *  descriptor (the active pill's `sourceIn/Out` window applied at
 *  the current `tTimeline`); the pool is target-driven, not
 *  cam-anchor-driven, so duplicate-source pills with distinct
 *  trim windows seek the `<video>` to the right frame. */
interface Slot {
  clipId: string;
  el: HTMLVideoElement;
  sourceDurS: number;
  warmed: boolean;
  cleanups: Array<() => void>;
  /** Last `sourceT` we synced this slot to. Used per-tick to tell a
   *  natural advance (small forward delta) apart from a jump (chunk
   *  click / scrub / loop wrap) so the seek policy can pick the right
   *  drift threshold. `null` until first contact, and reset whenever
   *  the slot leaves the cam's `[0, sourceDurS)` range — re-entry
   *  counts as first contact. */
  prevTargetSourceT: number | null;
  /** True from the moment we issue a `currentTime` write until the
   *  underlying decoder has actually presented a fresh frame for that
   *  new position. While set, the runtime keeps drawing the cached
   *  last-good bitmap (which was captured via `createImageBitmap` —
   *  the orientation-safe path) rather than risking a stale or
   *  not-yet-decoded sample. */
  awaitingFreshFrame: boolean;
  /** Monotonically increases on every presented video frame (each
   *  `requestVideoFrameCallback` fire). The runtime watches this to
   *  decide when to refresh its `createImageBitmap`-based snapshot
   *  cache: a bumped token means the decoder has a new frame ready
   *  and the snapshot will pick up something newer than the previous
   *  capture. Wraps at `Number.MAX_SAFE_INTEGER` (irrelevant in
   *  practice — never reached). */
  freshFrameToken: number;
  /** Pending continuous `requestVideoFrameCallback` handle. We chain
   *  rVFCs so we get one fire per presented frame for the lifetime of
   *  the slot — that drives both the `awaitingFreshFrame` clear AND
   *  the `freshFrameToken` increment. Null between unmount and the
   *  first arming. */
  rvfcHandle: number | null;
}

// `requestVideoFrameCallback` / `cancelVideoFrameCallback` are part of
// the standard `HTMLVideoElement` lib types (Chrome ≥ 90, Safari ≥ 17,
// Firefox ≥ 124). We runtime-check below for engines that haven't
// shipped them yet and fall back to a setTimeout-based watcher.

/** Per-tick sync target per cam. `sourceT` is seconds INSIDE the cam's
 *  media — already accounting for pill-trim, drift, anchor. The pool
 *  doesn't recompute that; whoever built the descriptor (pill-aware)
 *  did. */
export interface PoolSyncTarget {
  sourceT: number;
}

const READY_HAVE_CURRENT_DATA = 2;

export class VideoElementPool {
  private slots = new Map<string, Slot>();
  private createElement: () => HTMLVideoElement;
  private onDimsReport: (clipId: string, w: number, h: number) => void;
  private parent: HTMLElement | null = null;

  constructor(opts: VideoElementPoolOptions) {
    this.onDimsReport = opts.onDimsReport;
    this.createElement = opts.createElement ?? (() => document.createElement("video"));
    for (const cam of opts.cams) {
      this.addSlot(cam);
    }
  }

  /** Mount all elements as children of `parent`. Idempotent — safe to
   *  call after construction once a DOM container is available. */
  mount(parent: HTMLElement): void {
    this.parent = parent;
    for (const slot of this.slots.values()) {
      if (slot.el.parentNode !== parent) {
        parent.appendChild(slot.el);
      }
    }
  }

  /** Detach all elements from the DOM but keep them in memory. Used by
   *  tests + by Compositor.tsx unmount. Doesn't clear sync state. */
  unmount(): void {
    for (const slot of this.slots.values()) {
      slot.el.remove();
    }
    this.parent = null;
  }

  /** Look up the `<video>` for a given cam. Returns null when the cam
   *  isn't in the pool (caller decides how to handle — typically renders
   *  a test-pattern fallback). */
  getElement(clipId: string): HTMLVideoElement | null {
    return this.slots.get(clipId)?.el ?? null;
  }

  /** Whether the supplied `sourceT` lands inside the cam's source-time
   *  range. The runtime uses this to gate the last-good-frame fallback:
   *  out-of-range cams should stay black (correct empty state), in-range
   *  cams that are mid-seek should hold the cached frame to hide the
   *  decode-latency flash. */
  isSourceInRange(clipId: string, sourceT: number): boolean {
    const slot = this.slots.get(clipId);
    if (!slot) return false;
    return sourceT >= 0 && sourceT < slot.sourceDurS;
  }

  /** True while we've issued a seek to this slot's `<video>` but the
   *  decoder hasn't presented the post-seek frame yet. The runtime
   *  uses this as a hint to skip rendering until a fresh frame lands
   *  (avoids a brief stale-frame display during scrub / loop wrap). */
  isAwaitingFreshFrame(clipId: string): boolean {
    return this.slots.get(clipId)?.awaitingFreshFrame ?? false;
  }

  /** Monotonically-increasing token bumped on every presented video
   *  frame (per slot). The preview runtime watches this to refresh
   *  its `createImageBitmap` snapshot cache exactly once per new
   *  frame — every backend draw of the video then samples that
   *  bitmap instead of the live `<video>`, which sidesteps Chrome's
   *  `copyExternalImageToTexture` orientation bug entirely. Returns 0
   *  for unknown clipIds and for slots that haven't presented any
   *  frame yet. */
  getFreshFrameToken(clipId: string): number {
    return this.slots.get(clipId)?.freshFrameToken ?? 0;
  }

  /** Re-syncs every cam in the pool against per-cam sync targets. The
   *  runtime supplies `targets` from the current frame descriptor, where
   *  each entry is the active pill's `sourceIn/Out` evaluated at the
   *  current `tTimeline`. Cams with no entry are paused (no active pill =
   *  not on PROGRAM this tick). */
  syncAll(
    targets: ReadonlyMap<string, PoolSyncTarget>,
    isPlaying: boolean,
  ): void {
    for (const slot of this.slots.values()) {
      const t = targets.get(slot.clipId);
      if (!t) {
        // No target = cam not on PROGRAM. Reset prev-target so the next
        // in-range tick is treated as first contact (precise snap).
        slot.prevTargetSourceT = null;
        if (!slot.el.paused) slot.el.pause();
        continue;
      }
      syncSlot(slot, t.sourceT, isPlaying);
    }
  }

  /** Reconcile to a new cam list — adds slots for new cams, removes
   *  slots for vanished cams. Same-id cams keep their `<video>`
   *  (decoder stays hot). */
  setCams(cams: readonly VideoCam[]): void {
    const wantedIds = new Set(cams.map((c) => c.clip.id));
    for (const id of [...this.slots.keys()]) {
      if (!wantedIds.has(id)) {
        const slot = this.slots.get(id)!;
        for (const fn of slot.cleanups) fn();
        slot.el.remove();
        this.slots.delete(id);
      }
    }
    for (const cam of cams) {
      const existing = this.slots.get(cam.clip.id);
      if (existing) {
        // Update source-duration if the clip's metadata changed (lazy
        // metadata report) — anchor + drift are not tracked here anymore;
        // the per-frame descriptor handles cam-anchor / drift / pill-trim.
        existing.sourceDurS = cam.clip.sourceDurationS;
        continue;
      }
      this.addSlot(cam);
    }
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      for (const fn of slot.cleanups) fn();
      slot.el.remove();
      slot.el.removeAttribute("src");
      slot.el.load();
    }
    this.slots.clear();
    this.parent = null;
  }

  // ---- internals ----

  private addSlot(cam: VideoCam): void {
    const el = this.createElement();
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    // Hide the element via inline styles — it's only ever sampled as a
    // texture, never displayed. `display:none` would NOT prevent decode
    // in modern browsers (the spec allows decoders for hidden videos),
    // and we explicitly want decode to keep happening so cam-switches
    // don't pay first-decode latency.
    el.style.display = "none";
    el.src = cam.videoUrl;

    const slot: Slot = {
      clipId: cam.clip.id,
      el,
      sourceDurS: cam.clip.sourceDurationS,
      warmed: false,
      cleanups: [],
      prevTargetSourceT: null,
      awaitingFreshFrame: false,
      freshFrameToken: 0,
      rvfcHandle: null,
    };
    // Continuous rVFC chain: every presented frame bumps the slot's
    // token AND clears `awaitingFreshFrame` if it was set. Self-rearms
    // so the chain runs for the lifetime of the slot.
    armContinuousFrameCallback(slot);
    slot.cleanups.push(() => {
      if (slot.rvfcHandle != null) {
        try {
          el.cancelVideoFrameCallback(slot.rvfcHandle);
        } catch {
          /* handle may have already fired and been replaced */
        }
        slot.rvfcHandle = null;
      }
    });

    const reportDims = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        this.onDimsReport(cam.clip.id, el.videoWidth, el.videoHeight);
      }
    };
    el.addEventListener("loadedmetadata", reportDims);
    el.addEventListener("resize", reportDims);
    slot.cleanups.push(() => el.removeEventListener("loadedmetadata", reportDims));
    slot.cleanups.push(() => el.removeEventListener("resize", reportDims));
    // Try once immediately — the metadata might already be ready.
    reportDims();

    const warm = () => {
      if (slot.warmed) return;
      if (el.readyState < READY_HAVE_CURRENT_DATA) return;
      slot.warmed = true;
      const p = el.play();
      const stop = () => {
        if (!el.paused) el.pause();
      };
      if (p && typeof (p as Promise<void>).then === "function") {
        (p as Promise<void>).then(stop).catch(() => undefined);
      } else {
        stop();
      }
    };
    if (el.readyState >= READY_HAVE_CURRENT_DATA) {
      warm();
    } else {
      const onceReady = () => warm();
      el.addEventListener("loadeddata", onceReady, { once: true });
      slot.cleanups.push(() => el.removeEventListener("loadeddata", onceReady));
    }

    this.slots.set(cam.clip.id, slot);
    if (this.parent) {
      this.parent.appendChild(el);
    }
  }
}

// Stutter policy (mirrors `local/timing/cam-preview-sync.ts`): a per-
// tick `<video>.currentTime = X` write tears the decoder open from
// the nearest keyframe. On multi-GB phone recordings that takes
// 100–400 ms; if we re-issue every 16 ms because drift exceeded a
// tight threshold, we never let the decoder finish and playback
// stutters indefinitely. So:
//   • Jumps (large forward / any meaningful backward delta in the
//     source target) snap precisely — a user-meaningful resync.
//   • Natural advance is left alone unless drift is catastrophic.
//   • Mid-seek (`el.seeking`) ticks do nothing; we wait for the
//     in-flight seek to complete before considering another.
const JUMP_FORWARD_S = 0.5;
const JUMP_BACKWARD_S = 0.02;
const JUMP_DRIFT_THRESHOLD_S = 0.05;
const NATURAL_DRIFT_THRESHOLD_S = 0.5;

function syncSlot(slot: Slot, sourceT: number, isPlaying: boolean): void {
  const inRange = sourceT >= 0 && sourceT < slot.sourceDurS;
  const v = slot.el;
  if (!inRange) {
    slot.prevTargetSourceT = null;
    if (!v.paused) v.pause();
    return;
  }
  // Skip while a previous seek is still resolving. Don't update
  // prevTargetSourceT either — we want the next free tick to see the
  // full source-target delta from before the seek, so it can keep
  // classifying it as the same jump.
  if (v.seeking) return;

  const drift = Math.abs(v.currentTime - sourceT);
  const prev = slot.prevTargetSourceT;
  const isJump =
    prev === null ||
    sourceT - prev > JUMP_FORWARD_S ||
    sourceT - prev < -JUMP_BACKWARD_S;
  const driftThreshold = isJump
    ? JUMP_DRIFT_THRESHOLD_S
    : NATURAL_DRIFT_THRESHOLD_S;

  if (drift > driftThreshold) {
    try {
      v.currentTime = Math.max(0, Math.min(slot.sourceDurS, sourceT));
      // The continuous rVFC chain (armed in addSlot) will clear the
      // flag on the next presented frame. We just set the flag here
      // to signal "this slot is mid-seek" so the runtime knows to
      // hold its current bitmap until a fresh frame lands.
      slot.awaitingFreshFrame = true;
    } catch {
      /* element not ready yet — next tick */
    }
  }
  slot.prevTargetSourceT = sourceT;

  if (isPlaying && v.paused) {
    v.play().catch(() => undefined);
  } else if (!isPlaying && !v.paused) {
    v.pause();
  }
}

/** Self-rearming rVFC chain: each presented frame bumps the slot's
 *  `freshFrameToken` AND clears `awaitingFreshFrame` if it was set,
 *  then schedules itself again so the next frame fires the same
 *  callback. Runs for the slot's lifetime; cancelled in the slot's
 *  cleanups when the cam is removed.
 *
 *  Why drive snapshot refresh from rVFC instead of from RAF: rVFC
 *  fires exactly once per ACTUALLY-PRESENTED frame, with the source
 *  in a stable display orientation. RAF fires per render-tick
 *  whether or not the video has new content; if we snapshot on RAF
 *  we'd either over-snapshot (same frame multiple times) or
 *  occasionally snapshot on a tick where the source is mid-update
 *  (the orientation-bug window). rVFC gives us "exactly one
 *  reliable snapshot trigger per real frame".
 *
 *  Falls back to no-op when rVFC isn't supported — the runtime's
 *  existing time-throttled snapshot path keeps working. */
function armContinuousFrameCallback(slot: Slot): void {
  const v = slot.el;
  if (typeof v.requestVideoFrameCallback !== "function") return;
  const onFrame = () => {
    slot.freshFrameToken =
      slot.freshFrameToken < Number.MAX_SAFE_INTEGER
        ? slot.freshFrameToken + 1
        : 1;
    slot.awaitingFreshFrame = false;
    if (typeof v.requestVideoFrameCallback === "function") {
      slot.rvfcHandle = v.requestVideoFrameCallback(onFrame);
    } else {
      slot.rvfcHandle = null;
    }
  };
  slot.rvfcHandle = v.requestVideoFrameCallback(onFrame);
}
