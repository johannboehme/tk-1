/**
 * Streaming linear-interpolation resampler with mixdown-to-mono.
 *
 * Why linear interp instead of `OfflineAudioContext` like the fast path:
 *   - OAC needs the whole signal (or a chunk + edge-effect handling); we
 *     want O(1) memory across the streaming pipeline.
 *   - The downstream consumer is the sync algorithm (chroma + GCC-PHAT),
 *     which operates on 2048-sample STFT windows at 22050 Hz. Linear
 *     interpolation artefacts live well below that frequency resolution
 *     and don't measurably affect cross-correlation peaks.
 *   - Mixdown is just channel averaging — same as
 *     `webcodecs/audio-decode.ts`.
 *
 * The accumulator is a `GrowableF32`: we pre-allocate doubling buffers
 * so we don't pay the cost of one `Float32Array` reallocation per chunk.
 */

export interface MonoResampler {
  /** Source rate. Set on first `pushPlanar` / `pushInterleaved`; subsequent
   *  pushes must match (decoders don't switch rate mid-stream in our
   *  pipeline). */
  readonly sourceRate: number | null;
  /** Total mono samples produced so far. */
  readonly outputLength: number;
  /** Push N planar channels (each `Float32Array` length `frames`). */
  pushPlanar(channels: Float32Array[], sourceRate: number): void;
  /** Push interleaved channels: `data[ch * frames + f]` layout. */
  pushInterleaved(
    data: Float32Array,
    numberOfChannels: number,
    sourceRate: number,
  ): void;
  /** Final flush (emits any partial sample held by the resampler tail).
   *  Returns the accumulated mono PCM at the target sample rate. */
  finish(): Float32Array;
}

export interface MonoResamplerOptions {
  targetSampleRate: number;
  /** Initial heap pre-allocation (in mono samples). Doubles on overflow.
   *  Default: 22050 × 60 = 60 sec @ 22050 Hz = ~5 MB. */
  initialCapacity?: number;
}

export function createMonoResampler(
  opts: MonoResamplerOptions,
): MonoResampler {
  const target = opts.targetSampleRate;
  let sourceRate: number | null = null;
  let ratio = 1; // sourceRate / target — set on first push

  const buf = new GrowableF32(opts.initialCapacity ?? target * 60);

  // Linear-interp state across pushes: at the boundary, we owe some
  // output samples whose source indices fall after the last sample of
  // the previous push. We carry the *last sample of the previous push*
  // and the *next-output's fractional source index relative to push
  // start* across calls.
  let lastSample = 0; // mono mixed last sample of the previous batch
  let havePrev = false;
  let nextOutSrcPos = 0; // fractional source index where the next output sits
  // (resets per-batch by subtracting prev batch length; see push())

  function ensureRate(rate: number): void {
    if (sourceRate === null) {
      sourceRate = rate;
      ratio = rate / target;
    } else if (sourceRate !== rate) {
      throw new Error(
        `MonoResampler: source rate changed mid-stream ` +
          `(${sourceRate} → ${rate}). Not supported.`,
      );
    }
  }

  function pushMono(mono: Float32Array): void {
    if (mono.length === 0) return;
    // Build a virtual source array that includes the carried lastSample
    // at index -1: index 0 → mono[0], index -1 → lastSample (if havePrev).
    // We emit output samples while their source index falls in
    // [havePrev ? -1 : 0, mono.length - 1) — we stop one sample short
    // of the end so we always have a right neighbour for interpolation;
    // the held tail becomes the next batch's `lastSample`.
    const upper = mono.length - 1;
    let pos = nextOutSrcPos; // fractional, in source samples relative to mono[0]
    const lowerBound = havePrev ? -1 : 0;
    if (pos < lowerBound) {
      // Should not happen given our bookkeeping; clamp defensively.
      pos = lowerBound;
    }
    while (pos < upper) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = i0 < 0 ? lastSample : mono[i0];
      const b = mono[i0 + 1];
      buf.push(a + (b - a) * frac);
      pos += ratio;
    }
    // Carry: lastSample is the last actual source sample we've fully
    // covered. We now consider mono[mono.length - 1] as the "lastSample"
    // for the next batch; the next batch's mono[0] will be that sample's
    // right neighbour.
    lastSample = mono[upper];
    havePrev = true;
    // Next batch's output starts at source position `pos - mono.length`
    // (we crossed `mono.length` source samples in this batch, so subtract
    // for the new batch's coordinate system where the new sample 0 is
    // what was source-index `mono.length` of the old batch).
    nextOutSrcPos = pos - mono.length;
  }

  function mixdownPlanar(channels: Float32Array[]): Float32Array {
    const n = channels.length;
    if (n === 0) return new Float32Array(0);
    if (n === 1) return channels[0];
    const len = channels[0].length;
    const out = new Float32Array(len);
    const inv = 1 / n;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += channels[c][i];
      out[i] = s * inv;
    }
    return out;
  }

  function mixdownInterleaved(
    data: Float32Array,
    numberOfChannels: number,
  ): Float32Array {
    if (numberOfChannels === 1) return data;
    const frames = data.length / numberOfChannels;
    const out = new Float32Array(frames);
    const inv = 1 / numberOfChannels;
    for (let f = 0; f < frames; f++) {
      let s = 0;
      const base = f * numberOfChannels;
      for (let c = 0; c < numberOfChannels; c++) s += data[base + c];
      out[f] = s * inv;
    }
    return out;
  }

  return {
    get sourceRate() {
      return sourceRate;
    },
    get outputLength() {
      return buf.length;
    },
    pushPlanar(channels, rate) {
      ensureRate(rate);
      pushMono(mixdownPlanar(channels));
    },
    pushInterleaved(data, channels, rate) {
      ensureRate(rate);
      pushMono(mixdownInterleaved(data, channels));
    },
    finish(): Float32Array {
      // Emit one final sample for the tail (extrapolating from
      // lastSample). For typical decoders the few lost samples at the
      // very end are inaudible and irrelevant for sync. We just append
      // the lastSample as-is.
      if (havePrev) {
        buf.push(lastSample);
      }
      return buf.toFloat32Array();
    },
  };
}

class GrowableF32 {
  private data: Float32Array;
  private len = 0;
  constructor(initialCapacity: number) {
    this.data = new Float32Array(Math.max(1, initialCapacity));
  }
  get length(): number {
    return this.len;
  }
  push(v: number): void {
    if (this.len >= this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.len++] = v;
  }
  toFloat32Array(): Float32Array {
    return this.data.slice(0, this.len);
  }
}
