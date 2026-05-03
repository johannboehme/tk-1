/**
 * Public sync API.
 *
 * The expensive WASM matcher runs in a dedicated Web Worker
 * ([./sync.worker.ts](./sync.worker.ts)) so the main thread (and the
 * editor UI) stays interactive while a sync is in flight. Audio decoding
 * stays on the main thread — `OfflineAudioContext` has rough edges in
 * workers (especially Safari), and the resulting Float32Array buffers
 * are handed to the worker zero-copy via the structured-clone Transfer
 * mechanism.
 *
 * A small dispatch gate (`pauseSync` / `resumeSync`) lets callers defer
 * worker submissions when the editor is actively playing back, to avoid
 * cache/bandwidth contention with WebCodecs decoding. Phase 4 wires the
 * editor store into this; the gate is open by default.
 */

import { decodeAudioToMonoPcm } from "../codec/index";
import type { SyncWorkerRequest, SyncWorkerResponse } from "./sync.worker";

export interface MatchCandidate {
  /** Offset (master-timeline ms) at which this candidate would align the cam. */
  offsetMs: number;
  /** Sample-level Pearson correlation, ~0..1 (higher = more confident). */
  confidence: number;
  /** Number of sample frames used to compute the score (overlap window). */
  overlapFrames: number;
}

export interface SyncResult {
  offsetMs: number;
  confidence: number;
  driftRatio: number;
  method: string;
  warning: string | null;
  /** Top-K alternative offsets ranked by sample-level confidence.
   *  candidates[0] mirrors offsetMs/confidence (the chosen primary). */
  candidates: MatchCandidate[];
  /** Primary peak / second-highest peak on the matcher's ranking surface.
   *  `1.0` = a tie (UI should warn — the runner-up is just as good).
   *  `>1.5` ≈ comfortable margin. Saturates at ~1e6 when there is no
   *  runner-up (single isolated peak). Use this — not `confidence` — to
   *  decide whether the match is unambiguous: real-music chroma NCC sits
   *  at ~1.0 even on the failing pos-2000ms case, so the absolute number
   *  is a poor discriminator. */
  peakToSecondRatio: number;
  /** Primary peak / median correlation over valid lags. */
  peakToNoise: number;
  /** GCC-PHAT peak-to-noise ratio when the sample-level refinement
   *  ran. `0` if PHAT was skipped or rejected. >20 indicates a sharp
   *  same-source phase peak — the strongest "this match is unambiguous"
   *  signal we can produce; near-zero means the chroma lag was kept. */
  phatPnr: number;
}

const TARGET_SR = 22050;

export interface SyncInput {
  /** Reference audio: typically the audio extracted from the phone-recorded video. */
  refSource: Blob | ArrayBuffer | Float32Array;
  /** Query audio: typically the clean studio recording. */
  querySource: Blob | ArrayBuffer | Float32Array;
}

async function ensurePcm(
  source: Blob | ArrayBuffer | Float32Array,
): Promise<Float32Array> {
  if (source instanceof Float32Array) return source;
  const decoded = await decodeAudioToMonoPcm(source, TARGET_SR);
  return decoded.pcm;
}

interface RawCandidate {
  offset_ms: number;
  confidence: number;
  overlap_frames: number;
}

interface RawSyncResult {
  offset_ms: number;
  confidence: number;
  drift_ratio: number;
  method: string;
  warning: string | null;
  candidates?: RawCandidate[];
  peak_to_second_ratio?: number;
  peak_to_noise?: number;
  phat_pnr?: number;
}

/** Pure mapping helper — exported so it can be unit-tested without loading
 *  the WASM. The WASM returns snake_case to mirror Rust serde conventions;
 *  we expose camelCase to the rest of the codebase. */
export function mapWasmResult(raw: RawSyncResult): SyncResult {
  return {
    offsetMs: raw.offset_ms,
    confidence: raw.confidence,
    driftRatio: raw.drift_ratio,
    method: raw.method,
    warning: raw.warning,
    candidates: (raw.candidates ?? []).map((c) => ({
      offsetMs: c.offset_ms,
      confidence: c.confidence,
      overlapFrames: c.overlap_frames,
    })),
    // Older WASM bundles (pre-Tier-1.2) don't ship these fields. Fall
    // back to the saturation sentinel so consumers see a "no margin
    // info" reading instead of NaN/0 sneaking through.
    peakToSecondRatio: raw.peak_to_second_ratio ?? Number.POSITIVE_INFINITY,
    peakToNoise: raw.peak_to_noise ?? Number.POSITIVE_INFINITY,
    // PHAT default = 0 (i.e. "skipped / rejected") for pre-Tier-2 WASM.
    phatPnr: raw.phat_pnr ?? 0,
  };
}

// -----------------------------------------------------------------------------
// Dispatch gate: a tiny pause/resume primitive callers can use to defer
// dispatching new sync work (e.g. while the editor is playing back).
// -----------------------------------------------------------------------------

let pauseDeferred: { promise: Promise<void>; release: () => void } | null = null;

/**
 * Pause future `syncAudio()` dispatches. In-flight worker calls keep
 * running — the gate only affects calls that haven't yet handed work to
 * the worker. Idempotent.
 */
export function pauseSync(): void {
  if (pauseDeferred) return;
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  pauseDeferred = { promise, release };
}

/** Release any callers waiting at the gate. Idempotent. */
export function resumeSync(): void {
  if (!pauseDeferred) return;
  const d = pauseDeferred;
  pauseDeferred = null;
  d.release();
}

/** True iff the gate is currently closed. Useful for telemetry/UI. */
export function isSyncPaused(): boolean {
  return pauseDeferred !== null;
}

async function awaitGate(): Promise<void> {
  while (pauseDeferred) {
    await pauseDeferred.promise;
  }
}

// -----------------------------------------------------------------------------
// Worker dispatch
// -----------------------------------------------------------------------------

/** Callback fired between WASM pipeline stages. `fraction` is in [0, 1]
 *  and monotonically non-decreasing across calls within one match. */
export type SyncProgressFn = (stage: string, fraction: number) => void;

function runMatchInWorker(
  refPcm: Float32Array,
  queryPcm: Float32Array,
  sampleRate: number,
  onProgress?: SyncProgressFn,
): Promise<RawSyncResult> {
  return new Promise<RawSyncResult>((resolve, reject) => {
    const worker = new Worker(new URL("./sync.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      worker.terminate();
    };
    worker.addEventListener(
      "message",
      (e: MessageEvent<SyncWorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "progress") {
          // Don't terminate the worker on progress — keep listening for
          // the eventual "result" / "error" message.
          onProgress?.(msg.stage, msg.fraction);
          return;
        }
        if (msg.type === "result") {
          resolve(msg.result);
        } else {
          reject(new Error(msg.message));
        }
        cleanup();
      },
    );
    worker.addEventListener("error", (e) => {
      reject(new Error(e.message || "sync worker errored"));
      cleanup();
    });

    // Defensive copy: callers may reuse the same input array across calls
    // (e.g. the studio/master PCM is sent once per cam during a multi-cam
    // job). Transferring the original buffer detaches it on the main
    // thread, so the second call would throw "ArrayBuffer is already
    // detached". Slicing gives the worker its own buffer to consume while
    // leaving the caller's array intact.
    const refSlice = refPcm.slice();
    const querySlice = queryPcm.slice();
    const req: SyncWorkerRequest = {
      type: "match",
      refPcm: refSlice,
      queryPcm: querySlice,
      sampleRate,
    };
    worker.postMessage(req, [refSlice.buffer, querySlice.buffer]);
  });
}

export async function syncAudio(
  input: SyncInput,
  opts?: { onProgress?: SyncProgressFn },
): Promise<SyncResult> {
  const [refPcm, queryPcm] = await Promise.all([
    ensurePcm(input.refSource),
    ensurePcm(input.querySource),
  ]);
  await awaitGate();
  const raw = await runMatchInWorker(refPcm, queryPcm, TARGET_SR, opts?.onProgress);
  return mapWasmResult(raw);
}
