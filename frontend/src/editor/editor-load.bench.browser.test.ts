/**
 * Editor-load pipeline benchmark — real Chromium.
 *
 * Measures the per-stage cost of everything the editor does between "open a
 * job" and "timeline interactive", at realistic master-audio durations. The
 * point is to find where the "Loading editor…" wait actually goes — not the
 * JS bundle, not the file read, but the per-sample processing.
 *
 * Stages (all run on the decoded 22050 Hz mono PCM the editor works with):
 *   decode      WAV → mono PCM (floor; compressed sources cost more)
 *   pyramid     buildPeakPyramidAsync  (waveform peaks)
 *   pyramid$    getOrComputePyramid → getCachedPyramid (warm IDB read)
 *   analysis    getOrComputeAnalysis   (tempo/beats/onsets worker)
 *   loudness    buildLoudnessEnvelope  (sidechain envelope)
 *
 * Not a pass/fail gate — it logs a table. Read the console output.
 */
import { describe, it } from "vitest";
import { decodeAudioToMonoPcm } from "../local/codec";
import { buildPeakPyramidAsync } from "../core/waveform/build-pyramid-async";
import {
  getCachedPyramid,
  getOrComputePyramid,
} from "../local/waveform/pyramid-cache";
import { buildLoudnessEnvelope } from "../core/fx/audio-envelope";
import { getOrComputeAnalysis } from "../local/render/audio-analysis";

const SR = 22050;

/** Music-ish mono PCM: a tonal bed + a transient every 0.5 s so the
 *  onset/tempo analysis has real structure to chew on (silence would
 *  short-circuit the beat tracker and under-report its cost). */
function makePcm(durationS: number, sampleRate: number): Float32Array {
  const n = Math.floor(durationS * sampleRate);
  const pcm = new Float32Array(n);
  const beatPeriod = Math.floor(sampleRate * 0.5); // 120 BPM
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let s = 0.18 * Math.sin(2 * Math.PI * 110 * t);
    s += 0.12 * Math.sin(2 * Math.PI * 220 * t);
    const intoBeat = i % beatPeriod;
    if (intoBeat < sampleRate * 0.04) {
      const env = 1 - intoBeat / (sampleRate * 0.04);
      s += 0.5 * env * Math.sin(2 * Math.PI * 60 * t);
    }
    pcm[i] = Math.max(-1, Math.min(1, s));
  }
  return pcm;
}

/** 16-bit mono WAV blob from PCM (so the decode path has real bytes). */
function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x57415645, false);
  dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x64617461, false);
  dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function time<T>(fn: () => Promise<T> | T): Promise<{ ms: number; out: T }> {
  const t0 = performance.now();
  const out = await fn();
  return { ms: performance.now() - t0, out };
}

const f = (ms: number) => `${ms.toFixed(0).padStart(6)} ms`;

describe("editor-load pipeline benchmark", () => {
  // 1 / 4 / 15 min cover a single-take clip up to a long-form set.
  const DURATIONS = [60, 240, 900];

  it(
    "measures per-stage cost across audio durations",
    async () => {
      const rows: string[] = [];
      rows.push(
        `dur     samples     decode(WAV)    pyramid    pyramid$(warm)   loudness    analysis`,
      );

      for (const durationS of DURATIONS) {
        const pcm = makePcm(durationS, SR);
        const wav = pcmToWav(pcm, SR);
        const jobId = `bench-${durationS}-${pcm.length}`;

        const decode = await time(() => decodeAudioToMonoPcm(wav, SR));
        const decoded = decode.out;

        const pyramid = await time(() =>
          buildPeakPyramidAsync(decoded.pcm.slice(), decoded.sampleRate, {
            baseSamplesPerBucket: 64,
          }),
        );

        // Warm path: persist once, then measure the cached read the editor
        // would now hit instead of rebuilding.
        await getOrComputePyramid(jobId, decoded.pcm.slice(), decoded.sampleRate);
        const pyramidWarm = await time(() =>
          getCachedPyramid(jobId, decoded.sampleRate),
        );

        const loudness = await time(() =>
          buildLoudnessEnvelope(decoded.pcm.slice(), decoded.sampleRate),
        );

        let analysisMs = NaN;
        try {
          const analysis = await time(() =>
            getOrComputeAnalysis(
              `${jobId}-an`,
              decoded.pcm.slice(),
              decoded.sampleRate,
            ),
          );
          analysisMs = analysis.ms;
        } catch (e) {
          rows.push(`  analysis failed @${durationS}s: ${String(e)}`);
        }

        rows.push(
          `${`${durationS}s`.padStart(4)}  ${`${pcm.length}`.padStart(9)}   ` +
            `${f(decode.ms)}   ${f(pyramid.ms)}   ${f(pyramidWarm.ms)}    ` +
            `${f(loudness.ms)}  ${f(analysisMs)}`,
        );
      }

      // eslint-disable-next-line no-console
      console.log("\n========== EDITOR LOAD PIPELINE BENCHMARK ==========\n" +
        rows.join("\n") +
        "\n====================================================\n");
    },
    120_000,
  );

  // Real compressed sources go through WebCodecs (or ffmpeg.wasm fallback) —
  // a different cost class than the WAV floor above. The fixtures are short,
  // so we report ms-per-second-of-audio to extrapolate to a full track.
  it(
    "measures compressed-source decode (AAC / MP3) per second of audio",
    async () => {
      const out: string[] = [];
      for (const name of ["studio-aac.m4a", "studio-mp3.mp3"]) {
        try {
          const blob = await fetch(`/__test_fixtures__/${name}`).then((r) =>
            r.blob(),
          );
          // First call includes the streaming-module dynamic import (cold).
          const cold = await time(() => decodeAudioToMonoPcm(blob, SR));
          const warm = await time(() => decodeAudioToMonoPcm(blob, SR));
          const durS = cold.out.pcm.length / cold.out.sampleRate;
          const perSecCold = cold.ms / durS;
          out.push(
            `${name.padEnd(16)} bytes=${blob.size} audio=${durS.toFixed(1)}s  ` +
              `cold=${cold.ms.toFixed(0)}ms warm=${warm.ms.toFixed(0)}ms  ` +
              `→ ${perSecCold.toFixed(1)} ms/s  ` +
              `(extrapolated 240s≈${(perSecCold * 240).toFixed(0)}ms, ` +
              `900s≈${(perSecCold * 900).toFixed(0)}ms)`,
          );
        } catch (e) {
          out.push(`${name}: FAILED — ${String(e)}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log("\n========== COMPRESSED DECODE ==========\n" +
        out.join("\n") +
        "\n=======================================\n");
    },
    120_000,
  );
});
