/**
 * Worker for per-chunk mel-spectrogram computation.
 *
 * Lazy-loads the WASM module on first message. The mel routine is
 * cheap (≈ 50–200 ms per chunk) but synchronous, so running it on
 * the main thread would jank the UI when a 30-chunk session is being
 * back-filled at mount time.
 */

interface SyncCoreModule {
  default(): Promise<unknown>;
  melSpectrogram(
    pcm: Float32Array,
    sampleRate: number,
    nMels: number,
    fps: number,
  ): { data: Uint8Array | number[]; n_mels: number; n_frames: number };
  chromaProfile(pcm: Float32Array, sampleRate: number): Float32Array;
}

let modulePromise: Promise<SyncCoreModule> | null = null;

async function loadCore(): Promise<SyncCoreModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = (await import(
        "../../../wasm/sync-core/pkg/sync_core.js"
      )) as unknown as SyncCoreModule;
      await mod.default();
      return mod;
    })();
  }
  return modulePromise;
}

interface MelMessage {
  type: "mel";
  id: number;
  pcm: Float32Array;
  sampleRate: number;
  nMels: number;
  fps: number;
}

self.addEventListener("message", async (e: MessageEvent<MelMessage>) => {
  const msg = e.data;
  if (msg?.type !== "mel") return;
  try {
    const wasm = await loadCore();
    const r = wasm.melSpectrogram(msg.pcm, msg.sampleRate, msg.nMels, msg.fps);
    // serde-wasm-bindgen serializes Vec<u8> as Array<number> by default.
    // Repack into a Uint8Array so callers don't pay per-pixel boxing.
    const u8 =
      r.data instanceof Uint8Array
        ? r.data
        : Uint8Array.from(r.data as number[]);
    // Same PCM slice — pull out a 12-bin time-averaged chroma so the
    // Cockpit KEY tag has something to chew on. Float32Array out.
    const chroma = wasm.chromaProfile(msg.pcm, msg.sampleRate);
    const chromaCopy = new Float32Array(chroma); // detach from WASM memory
    (self as DedicatedWorkerGlobalScope).postMessage(
      {
        type: "result",
        id: msg.id,
        data: u8,
        nMels: r.n_mels,
        nFrames: r.n_frames,
        chroma: chromaCopy,
      },
      [u8.buffer, chromaCopy.buffer],
    );
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
