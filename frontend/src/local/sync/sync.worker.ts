/**
 * Sync Worker — runs the WASM matcher off the main thread.
 *
 * Why: `syncAudioPcm` is CPU-heavy (~hundreds of ms to seconds for a few
 * minutes of audio). On the main thread it freezes the UI, which used to
 * be acceptable when sync only ran upfront on the upload screen, but with
 * sync moving into the editor (B-roll add, cam re-prep) the editor must
 * stay interactive. Running here on a DedicatedWorker is the cleanest fix.
 *
 * Decoding (WebAudio → mono PCM) stays on the main thread because
 * OfflineAudioContext has Safari-side caveats inside workers; we transfer
 * the resulting Float32Array buffers into the worker zero-copy instead.
 *
 * Progress: the WASM pipeline calls `syncAudioPcmWithProgress` with a
 * Rust→JS closure that fires per pipeline stage (envelope, chroma,
 * onset, ncc, phat, consensus, drift). Each fire becomes a `progress`
 * postMessage so the main thread can paint a smooth bar instead of a
 * 5-s frozen "40%".
 */

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
}

export type SyncWorkerRequest = {
  type: "match";
  refPcm: Float32Array;
  queryPcm: Float32Array;
  sampleRate: number;
};

export type SyncWorkerResponse =
  | { type: "result"; result: RawSyncResult }
  | { type: "progress"; stage: string; fraction: number }
  | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let wasmInitialized: Promise<typeof import("../../../wasm/sync-core/pkg/sync_core.js")> | null = null;

async function loadWasm() {
  if (!wasmInitialized) {
    wasmInitialized = (async () => {
      const mod = await import("../../../wasm/sync-core/pkg/sync_core.js");
      await mod.default();
      return mod;
    })();
  }
  return wasmInitialized;
}

ctx.addEventListener("message", async (e: MessageEvent<SyncWorkerRequest>) => {
  const msg = e.data;
  if (msg.type !== "match") return;
  try {
    const wasm = await loadWasm();
    // Bridge WASM stage callbacks → main-thread progress events. The
    // WASM call is synchronous from the worker's point of view, but
    // postMessage is non-blocking so each stage update reaches the UI
    // immediately even though the worker is otherwise pegged.
    const onStage = (stage: string, fraction: number) => {
      const evt: SyncWorkerResponse = { type: "progress", stage, fraction };
      ctx.postMessage(evt);
    };
    const result = wasm.syncAudioPcmWithProgress(
      msg.refPcm,
      msg.queryPcm,
      msg.sampleRate,
      onStage,
    ) as RawSyncResult;
    const evt: SyncWorkerResponse = { type: "result", result };
    ctx.postMessage(evt);
  } catch (err) {
    const evt: SyncWorkerResponse = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(evt);
  }
});
