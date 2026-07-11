import type { PeakPyramid } from "../core/waveform/peak-pyramid";

export interface MasterAudioWave {
  pyramid: PeakPyramid;
  duration: number;
}

export interface DecodedPcm {
  pcm: Float32Array;
  sampleRate: number;
}

export interface LoadMasterAudioDeps {
  /** Read the persisted peak-pyramid from IDB (pre-warmed by the sync step). */
  getCachedPyramid: (
    jobId: string,
    sampleRate: number,
  ) => Promise<PeakPyramid | undefined>;
  /** Decode the master audio to mono PCM. Expensive (1–3 s) — runs at most once. */
  decode: () => Promise<DecodedPcm>;
  /** Build the pyramid from decoded PCM and persist it for the next open. */
  buildPyramid: (
    jobId: string,
    pcm: Float32Array,
    sampleRate: number,
  ) => Promise<PeakPyramid>;
}

export interface LoadedMasterAudio {
  /** Waveform for the timeline, or null if the audio couldn't be prepared. */
  wave: MasterAudioWave | null;
  /**
   * Lazily provide the decoded PCM — needed only for audio-analysis on a cache
   * miss and for the sidechain loudness envelope, never for first paint.
   * Memoized: decodes at most once, and reuses the decode already done on the
   * cache-miss path rather than decoding twice.
   */
  getPcm: () => Promise<DecodedPcm | null>;
}

/**
 * Prepare the master waveform for the editor, decode-free when possible.
 *
 * The sync step persists the peak-pyramid, and the pyramid carries the true
 * master-audio duration (`durationS = samples / sampleRate`). When that cache
 * is warm we hand the timeline its waveform — and `loadJob` its duration —
 * without decoding a single sample. The decode (1–3 s) then only happens
 * lazily, in the background, for the sidechain loudness envelope.
 *
 * On a cold/un-synced job there is no cached pyramid, so we must decode to
 * learn the real duration and build the pyramid (which `buildPyramid` also
 * persists, so the next open is fast). That decoded PCM is reused by
 * `getPcm()` rather than decoded a second time.
 *
 * Note the duration always traces back to a real decode — never to the job's
 * `durationS`, which is the lead-cam *video* length, not the master audio.
 */
export async function loadMasterAudio(
  jobId: string,
  sampleRate: number,
  deps: LoadMasterAudioDeps,
): Promise<LoadedMasterAudio> {
  // Memoized PCM provider: a single decode shared by every consumer.
  let pcmPromise: Promise<DecodedPcm | null> | null = null;
  const getPcm = (): Promise<DecodedPcm | null> => {
    if (!pcmPromise) pcmPromise = deps.decode().catch(() => null);
    return pcmPromise;
  };

  const cached = await deps
    .getCachedPyramid(jobId, sampleRate)
    .catch(() => undefined);
  if (cached) {
    return { wave: { pyramid: cached, duration: cached.durationS }, getPcm };
  }

  // Cold path: decode (via the memoized provider so it isn't repeated) to
  // learn the real duration, then build + persist the pyramid.
  const decodedPcm = await getPcm();
  if (!decodedPcm) return { wave: null, getPcm };
  try {
    const pyramid = await deps.buildPyramid(
      jobId,
      decodedPcm.pcm,
      decodedPcm.sampleRate,
    );
    return { wave: { pyramid, duration: pyramid.durationS }, getPcm };
  } catch {
    return { wave: null, getPcm };
  }
}
