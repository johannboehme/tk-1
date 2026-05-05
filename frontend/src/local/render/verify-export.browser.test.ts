import { describe, it, expect } from "vitest";
import { editRenderMulti } from "./edit";
import { decodeAudioToMonoPcm } from "../codec/webcodecs/audio-decode";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import { CamFrameStream } from "./cam-frame-stream";

const RED_URL = "/__test_fixtures__/cam-red.mp4";
const BLUE_URL = "/__test_fixtures__/cam-blue.mp4";

function makeWav(samples: Float32Array, channels: number, sampleRate: number): Blob {
  const numSamples = samples.length / channels;
  const dataLen = numSamples * channels * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x57415645, false);
  dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x64617461, false);
  dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

function makeSineWav(freqHz: number, durationS: number, sampleRate: number): Blob {
  const n = Math.floor(durationS * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return makeWav(samples, 1, sampleRate);
}

async function decodeFrameColorsAt(
  mp4Bytes: Uint8Array,
  targetTimesS: number[],
): Promise<{ tS: number; r: number; g: number; b: number; dominant: string }[]> {
  const stream = await CamFrameStream.create(new Blob([mp4Bytes as BlobPart]));
  const canvas = new OffscreenCanvas(stream.width, stream.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas 2d");
  const out: { tS: number; r: number; g: number; b: number; dominant: string }[] = [];
  try {
    for (const tS of targetTimesS) {
      const frame = await stream.frameAtOrBefore(Math.round(tS * 1_000_000));
      if (!frame) {
        out.push({ tS, r: 0, g: 0, b: 0, dominant: "missing" });
        continue;
      }
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
      const px = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      const r = px[0], g = px[1], b = px[2];
      let dominant = "neutral";
      if (r > g + 30 && r > b + 30) dominant = "red";
      else if (b > r + 30 && b > g + 30) dominant = "blue";
      else if (g > r + 30 && g > b + 30) dominant = "green";
      out.push({ tS, r, g, b, dominant });
    }
  } finally {
    stream.close();
  }
  return out;
}

describe("Export verification — multi-cam × multi-pill × multi-segment", () => {
  it(
    "produces a valid MP4 with the correct cam at every output time",
    async () => {
      const [redBlob, blueBlob] = await Promise.all([
        (await fetch(RED_URL)).blob(),
        (await fetch(BLUE_URL)).blob(),
      ]);
      const audio = makeSineWav(880, 6.0, 48000);

      // Pills cover arr [0..5). Segments [0..2), [3..5) cut MASTER time —
      // but arr-time runs continuously through the output (matching
      // masterToArr's projection), so pills are addressed by their
      // arr-time, NOT by master-time. tArr just walks 0..4 over the
      // 4-second output without any gaps.
      //
      // Output mapping:
      //   output 0..1s ← tArr 0..1 → Pill 1 (red,  source 3..4)
      //   output 1..2s ← tArr 1..2 → Pill 2 (blue, source 0..1)
      //   output 2..3s ← tArr 2..3 → Pill 3 (red,  source 1..2)
      //   output 3..4s ← tArr 3..4 → Pill 4 (blue, source 4..5)
      //   (Pill 5 at arr [4..5) is never reached.)
      const result = await editRenderMulti({
        cams: [
          { id: "red",  file: redBlob,  masterStartS: 0, sourceDurationS: 6, kind: "video" },
          { id: "blue", file: blueBlob, masterStartS: 0, sourceDurationS: 6, kind: "video" },
        ],
        cuts: [],
        pills: [
          { id: "p1", camId: "red",  arrStartS: 0, arrEndS: 1, sourceInS: 3, sourceOutS: 4, originalArrStartS: 0, originalArrEndS: 1, originalSourceInS: 3, originalSourceOutS: 4 },
          { id: "p2", camId: "blue", arrStartS: 1, arrEndS: 2, sourceInS: 0, sourceOutS: 1, originalArrStartS: 1, originalArrEndS: 2, originalSourceInS: 0, originalSourceOutS: 1 },
          { id: "p3", camId: "red",  arrStartS: 2, arrEndS: 3, sourceInS: 1, sourceOutS: 2, originalArrStartS: 2, originalArrEndS: 3, originalSourceInS: 1, originalSourceOutS: 2 },
          { id: "p4", camId: "blue", arrStartS: 3, arrEndS: 4, sourceInS: 4, sourceOutS: 5, originalArrStartS: 3, originalArrEndS: 4, originalSourceInS: 4, originalSourceOutS: 5 },
          { id: "p5", camId: "red",  arrStartS: 4, arrEndS: 5, sourceInS: 2, sourceOutS: 3, originalArrStartS: 4, originalArrEndS: 5, originalSourceInS: 2, originalSourceOutS: 3 },
        ],
        masterDurationS: 6,
        audioFile: audio,
        segments: [{ in: 0, out: 2 }, { in: 3, out: 5 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1.0,
        outputFps: 30,
      });

      expect(result.output).not.toBeNull();
      const outBytes = result.output!;

      // 1. Re-demux: valid MP4 with video.
      const reparsed = await demuxVideoTrack(new Blob([outBytes as BlobPart]));
      expect(reparsed).not.toBeNull();
      console.log(`[verify] video duration=${reparsed!.info.durationS.toFixed(3)}s ` +
                  `${reparsed!.info.width}x${reparsed!.info.height} fps=${reparsed!.info.fps.toFixed(1)} ` +
                  `chunks=${reparsed!.chunks.length}`);

      // Expected duration: 2 + 2 = 4 seconds (segments).
      expect(reparsed!.info.durationS).toBeGreaterThan(3.7);
      expect(reparsed!.info.durationS).toBeLessThan(4.3);

      // Frame count ≈ 4s × 30fps = 120 ± rounding.
      expect(reparsed!.chunks.length).toBeGreaterThan(110);
      expect(reparsed!.chunks.length).toBeLessThan(130);

      // 2. Audio: matching duration + correct frequency.
      const audioOut = await decodeAudioToMonoPcm(new Blob([outBytes as BlobPart]), 22050);
      console.log(`[verify] audio duration=${audioOut.durationS.toFixed(3)}s pcm.length=${audioOut.pcm.length}`);
      expect(audioOut.durationS).toBeGreaterThan(3.7);
      expect(audioOut.durationS).toBeLessThan(4.3);

      // A/V duration alignment within ~1 frame.
      expect(Math.abs(reparsed!.info.durationS - audioOut.durationS)).toBeLessThan(0.1);

      // Audio frequency: 880 Hz → ~880 zero-crossings/sec.
      const win = audioOut.pcm.slice(11025, 11025 + 22050);
      let zc = 0;
      for (let i = 1; i < win.length; i++) {
        if (win[i - 1] <= 0 && win[i] > 0) zc++;
      }
      console.log(`[verify] audio zero-crossings in 1s window: ${zc}`);
      expect(zc).toBeGreaterThan(820);
      expect(zc).toBeLessThan(940);

      // 3. The big one: at every probe time, decode the output frame and
      //    verify its dominant color = the expected cam at that arr-time.
      const colors = await decodeFrameColorsAt(outBytes, [0.5, 1.5, 2.5, 3.5]);
      console.log("[verify] sampled output frames (centre pixel):");
      for (const c of colors) {
        console.log(`  t=${c.tS.toFixed(2)}s  rgb=${c.r},${c.g},${c.b}  → ${c.dominant}`);
      }
      expect(colors[0].dominant).toBe("red");   // Pill 1 @ arr 0.5
      expect(colors[1].dominant).toBe("blue");  // Pill 2 @ arr 1.5
      expect(colors[2].dominant).toBe("red");   // Pill 3 @ arr 2.5
      expect(colors[3].dominant).toBe("blue");  // Pill 4 @ arr 3.5
    },
    180_000,
  );
});
