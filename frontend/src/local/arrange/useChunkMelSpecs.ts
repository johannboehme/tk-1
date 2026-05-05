/**
 * Orchestrates the per-chunk audio glance pipeline for the Arrange page.
 *
 *   1. Load the master AudioAnalysis (cached in IDB; computes once per
 *      job in a worker).
 *   2. For every chunk: try the IDB mel-spec cache first; on miss,
 *      decode the master PCM (only once per page-mount) and compute
 *      the mel-spec in the worker, then cache it.
 *
 * Both passes are off the hot path — the user sees the polaroids and
 * cockpit render immediately; mel/auto-tags fade in as the worker
 * delivers them.
 */
import { useEffect, useRef } from "react";
import { useArrangeStore } from "./arrange-store";
import { computeChunkMelSpec, type ChunkMelData } from "./chunk-mel";
import { jobsDb } from "../../storage/jobs-db";
import { getOrComputeAnalysis } from "../render/audio-analysis";
import type { AudioAnalysis } from "../render/audio-analysis/types";
import { decodeAudioToMonoPcm } from "../codec";
import { resolveJobAssetUrl } from "../jobs";

const MEL_SAMPLE_RATE = 22050;
/** How many chunks to compute concurrently. The single-worker pipeline
 *  serialises naturally; this only controls the burst size of pending
 *  postMessages — keeping it at 1 makes back-pressure trivial. */
const CONCURRENCY = 1;

export function useChunkMelSpecs() {
  const jobId = useArrangeStore((s) => s.jobId);
  const chunks = useArrangeStore((s) => s.chunks);
  const setAnalysis = useArrangeStore((s) => s.setAnalysis);
  const setChunkMel = useArrangeStore((s) => s.setChunkMel);

  // Cache the resolved master-PCM at the hook level so a chunk-pool
  // change (re-detection, accept toggles) doesn't trigger a redecode.
  const pcmRef = useRef<{
    jobId: string;
    pcm: Float32Array;
    sampleRate: number;
  } | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!jobId) return;

    let cancelled = false;
    (async () => {
      try {
        // Load mel-specs from cache first — nice and quick. Records
        // saved before chroma landed have `chroma === undefined`; we
        // treat those as "needs compute" so KEY detection backfills.
        const melsFromCache: Array<[string, ChunkMelData] | null> =
          await Promise.all(
            chunks.map(async (c): Promise<[string, ChunkMelData] | null> => {
              const rec = await jobsDb.getChunkMelSpec(jobId, c.id);
              if (!rec || !rec.chroma) return null;
              return [
                c.id,
                {
                  data: rec.data,
                  nMels: rec.nMels,
                  nFrames: rec.nFrames,
                  durationS: rec.durationS,
                  chroma: rec.chroma,
                },
              ];
            }),
          );
        if (cancelled) return;
        for (const entry of melsFromCache) {
          if (entry) setChunkMel(entry[0], entry[1]);
        }

        // Identify chunks that still need a fresh compute.
        const missing = chunks.filter(
          (_, i) => melsFromCache[i] === null,
        );

        // Decode the master PCM once if anything is missing OR if the
        // analysis isn't cached. Skip otherwise — the user already has
        // a fully cached job, no need to spin up the codec.
        const cachedAnalysis =
          (await jobsDb.getAudioAnalysis<AudioAnalysis>(jobId)) ?? null;

        let needPcm = missing.length > 0 || cachedAnalysis === null;
        if (needPcm) {
          const pcmBundle = await ensurePcm(jobId);
          if (cancelled || !pcmBundle) return;
          pcmRef.current = pcmBundle;

          // Kick off analysis (worker, cached on success).
          const analysis = await getOrComputeAnalysis(
            jobId,
            pcmBundle.pcm,
            pcmBundle.sampleRate,
          );
          if (cancelled) return;
          setAnalysis(analysis);

          // Per-chunk mel-spec — bounded concurrency, sequential by
          // default (worker is the bottleneck, no point fanning out).
          await runWithConcurrency(missing, CONCURRENCY, async (chunk) => {
            if (cancelled) return;
            const startSample = Math.max(
              0,
              Math.floor((chunk.startMs / 1000) * pcmBundle.sampleRate),
            );
            const endSample = Math.min(
              pcmBundle.pcm.length,
              Math.ceil((chunk.endMs / 1000) * pcmBundle.sampleRate),
            );
            if (endSample <= startSample) return;
            const slice = pcmBundle.pcm.subarray(startSample, endSample);
            try {
              const mel = await computeChunkMelSpec(
                slice,
                pcmBundle.sampleRate,
              );
              if (cancelled) return;
              setChunkMel(chunk.id, mel);
              await jobsDb
                .saveChunkMelSpec(
                  jobId,
                  chunk.id,
                  mel.data,
                  mel.nMels,
                  mel.nFrames,
                  mel.durationS,
                  mel.chroma,
                )
                .catch(() => undefined);
            } catch {
              // Compute failed — leave the chunk without a mel-spec;
              // UI shows the empty-state.
            }
          });
        } else if (cachedAnalysis) {
          setAnalysis(cachedAnalysis);
        }
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn("[chunk-mel] orchestration failed:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // chunk pool is stable for the duration of an arrange-page mount,
    // so a `chunks` dep here doesn't churn — but include for safety
    // when the user re-enters Triage and adds new chunks.
  }, [jobId, chunks, setAnalysis, setChunkMel]);
}

async function ensurePcm(
  jobId: string,
): Promise<{ jobId: string; pcm: Float32Array; sampleRate: number } | null> {
  // Master audio is reachable as the job's "audio" asset; resolve to a
  // Blob via the job-asset URL helper, then decode to mono PCM.
  const url = await resolveJobAssetUrl(jobId, "audio");
  if (!url) return null;
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const decoded = await decodeAudioToMonoPcm(blob, MEL_SAMPLE_RATE);
    return { jobId, pcm: decoded.pcm, sampleRate: decoded.sampleRate };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const lanes: Promise<void>[] = [];
  const lim = Math.max(1, Math.min(concurrency, queue.length));
  for (let i = 0; i < lim; i++) {
    lanes.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) return;
          await worker(next);
        }
      })(),
    );
  }
  await Promise.all(lanes);
}
