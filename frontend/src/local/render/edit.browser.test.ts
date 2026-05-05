import { describe, it, expect } from "vitest";
import { editRender, editRenderMulti } from "./edit";
import { decodeAudioToMonoPcm } from "../codec/webcodecs/audio-decode";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import { ShowwavesVisualizer } from "./visualizer/showwaves";
import { ShowfreqsVisualizer } from "./visualizer/showfreqs";
import { computeEnergyCurves } from "./energy";

const VIDEO_FIXTURE_URL = "/__test_fixtures__/tone-3s.mp4";
const MULTI_KEYFRAME_FIXTURE_URL = "/__test_fixtures__/video-multi-keyframe.mp4";

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

describe("editRender (real Chromium WebCodecs + mp4-muxer)", () => {
  it(
    "renders the full clip with re-encoded video + new audio when no segments are given",
    async () => {
      const videoBlob = await (await fetch(VIDEO_FIXTURE_URL)).blob();
      const studioAudio = makeSineWav(880, 3.0, 48000);

      const result = await editRender({
        videoFile: videoBlob,
        audioFile: studioAudio,
        segments: [],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1.0,
      });

      expect(result.output).not.toBeNull();
      const outBytes = result.output!;
      expect(outBytes.byteLength).toBeGreaterThan(1000);
      expect(result.width).toBe(320);
      expect(result.height).toBe(240);

      // Output is a re-encoded MP4 — re-parse it and verify dimensions.
      const reparsed = await demuxVideoTrack(new Blob([outBytes as BlobPart]));
      expect(reparsed).not.toBeNull();
      expect(reparsed!.info.width).toBe(320);
      expect(reparsed!.info.height).toBe(240);

      // Audio is the studio tone (zero-crossing rate ≈ 1760/s).
      const audio = await decodeAudioToMonoPcm(new Blob([outBytes as BlobPart]), 22050);
      const window = audio.pcm.slice(22050, 22050 * 2);
      let zc = 0;
      for (let i = 1; i < window.length; i++) {
        if (window[i - 1] <= 0 && window[i] > 0) zc++;
      }
      expect(zc).toBeGreaterThan(800);
      expect(zc).toBeLessThan(900);
    },
    60_000,
  );

  it(
    "respects a segment cut: trimming [0.5, 2.0] yields a 1.5 s output",
    async () => {
      const videoBlob = await (await fetch(VIDEO_FIXTURE_URL)).blob();
      const studioAudio = makeSineWav(880, 3.0, 48000);

      const result = await editRender({
        videoFile: videoBlob,
        audioFile: studioAudio,
        segments: [{ in: 0.5, out: 2.0 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1.0,
      });

      const reparsed = await demuxVideoTrack(new Blob([result.output! as BlobPart]));
      expect(reparsed).not.toBeNull();
      // Output duration should be ≈ 1.5 s ± frame-rate granularity (33 ms).
      expect(reparsed!.info.durationS).toBeGreaterThan(1.3);
      expect(reparsed!.info.durationS).toBeLessThan(1.7);
    },
    60_000,
  );

  it(
    "burns in an ASS subtitle overlay via JASSUB — output frames carry bright text pixels",
    async () => {
      const videoBlob = await (await fetch(VIDEO_FIXTURE_URL)).blob();
      const studioAudio = makeSineWav(880, 3.0, 48000);

      const result = await editRender({
        videoFile: videoBlob,
        audioFile: studioAudio,
        segments: [],
        overlays: [
          {
            text: "HELLO",
            start: 0.0,
            end: 3.0,
            preset: "outline",
            x: 0.5,
            y: 0.5,
            animation: "fade",
            reactiveBand: null,
            reactiveParam: "scale",
            reactiveAmount: 0,
          },
        ],
        offsetMs: 0,
        driftRatio: 1.0,
      });

      const reparsed = await demuxVideoTrack(new Blob([result.output! as BlobPart]));
      expect(reparsed).not.toBeNull();

      // Decode a frame near the middle and check that the centre region
      // contains pixels noticeably different from the source's pure red.
      // ASS "outline" preset draws WHITE text with BLACK outline — both
      // contrast strongly against the red background.
      let centerNonRedPixels = 0;
      let frameCount = 0;
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (frameCount === 1) {
            const bm = new OffscreenCanvas(frame.codedWidth, frame.codedHeight);
            const ctx = bm.getContext("2d")!;
            ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
            // Centre 100×60 region.
            const cx = Math.floor(frame.codedWidth / 2) - 50;
            const cy = Math.floor(frame.codedHeight / 2) - 30;
            const data = ctx.getImageData(cx, cy, 100, 60).data;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              // White-ish or black-ish pixels stand out from the red
              // background (R≈255, G≈0, B≈0).
              if (g > 50 || b > 50 || r < 100) centerNonRedPixels++;
            }
          }
          frame.close();
          frameCount++;
        },
        error: () => {},
      });
      decoder.configure({
        codec: reparsed!.info.codec,
        codedWidth: reparsed!.info.width,
        codedHeight: reparsed!.info.height,
        description: reparsed!.info.description,
      });
      for (const c of reparsed!.chunks.slice(0, 4)) {
        decoder.decode(
          new EncodedVideoChunk({
            type: c.isKey ? "key" : "delta",
            timestamp: c.timestampUs,
            duration: c.durationUs,
            data: c.data,
          }),
        );
      }
      await decoder.flush();
      decoder.close();

      // "HELLO" in size-64 font fills well over 200 pixels in a 100×60
      // window. Anything > 100 confirms the subtitle was burned in.
      expect(centerNonRedPixels).toBeGreaterThan(100);
    },
    120_000,
  );

  it(
    "renders with showwaves + showfreqs visualizers — output frames have non-trivial bottom-strip pixels",
    async () => {
      const videoBlob = await (await fetch(VIDEO_FIXTURE_URL)).blob();
      const studioAudio = makeSineWav(880, 3.0, 48000);

      // Decode the studio audio to PCM for the visualizers + energy curves.
      const decoded = await decodeAudioToMonoPcm(studioAudio, 22050);
      const energy = computeEnergyCurves(decoded.pcm, 22050, 30);

      const result = await editRender({
        videoFile: videoBlob,
        audioFile: studioAudio,
        segments: [],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1.0,
        energy,
        visualizers: [
          new ShowwavesVisualizer({ pcm: decoded.pcm, sampleRate: 22050 }),
          new ShowfreqsVisualizer({ energy, yPosition: 8 }),
        ],
      });

      // Decode a few frames of the output and verify the bottom strip is
      // not entirely the source-frame red — visualizers must have painted
      // pixels there.
      const reparsed = await demuxVideoTrack(new Blob([result.output! as BlobPart]));
      expect(reparsed).not.toBeNull();

      let nonRedPixelCount = 0;
      let frameCount = 0;
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (frameCount > 0 && frameCount < 5) {
            const bm = new OffscreenCanvas(frame.codedWidth, frame.codedHeight);
            const ctx = bm.getContext("2d")!;
            ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
            // Sample the bottom 80px strip — visualizers paint there.
            const data = ctx.getImageData(
              0,
              frame.codedHeight - 80,
              frame.codedWidth,
              80,
            ).data;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              // Source video is pure red (255,0,0). Visualizer overlays
              // change either G or B (or alpha-darken everything).
              if (g > 30 || b > 30 || r < 200) nonRedPixelCount++;
            }
          }
          frame.close();
          frameCount++;
        },
        error: () => {},
      });
      decoder.configure({
        codec: reparsed!.info.codec,
        codedWidth: reparsed!.info.width,
        codedHeight: reparsed!.info.height,
        description: reparsed!.info.description,
      });
      for (const c of reparsed!.chunks.slice(0, 6)) {
        decoder.decode(
          new EncodedVideoChunk({
            type: c.isKey ? "key" : "delta",
            timestamp: c.timestampUs,
            duration: c.durationUs,
            data: c.data,
          }),
        );
      }
      await decoder.flush();
      decoder.close();

      expect(nonRedPixelCount).toBeGreaterThan(1000);
    },
    120_000,
  );
});

describe("editRenderMulti — pill-mode + streaming muxer", () => {
  it(
    "renders a 1-cam pill arrangement with sparse source-time access (validates GOP-seek + parallel pipeline + streaming encoder→muxer)",
    async () => {
      // 6-second source with keyframes every 1s. We build pills that
      // pull from non-monotonic source-time windows — late, then early,
      // then mid — to exercise both auto-seek directions.
      const videoBlob = await (await fetch(MULTI_KEYFRAME_FIXTURE_URL)).blob();
      const audioBlob = makeSineWav(440, 3.0, 48000);
      const camId = "cam-A";

      const pills = [
        // Pill 1: arr [0..1), source [4..5)  — far forward of t=0
        {
          id: "p1",
          camId,
          arrStartS: 0,
          arrEndS: 1,
          sourceInS: 4,
          sourceOutS: 5,
          originalArrStartS: 0,
          originalArrEndS: 1,
          originalSourceInS: 4,
          originalSourceOutS: 5,
        },
        // Pill 2: arr [1..2), source [0..1)  — backwards seek to start
        {
          id: "p2",
          camId,
          arrStartS: 1,
          arrEndS: 2,
          sourceInS: 0,
          sourceOutS: 1,
          originalArrStartS: 1,
          originalArrEndS: 2,
          originalSourceInS: 0,
          originalSourceOutS: 1,
        },
        // Pill 3: arr [2..3), source [2..3)  — forward seek
        {
          id: "p3",
          camId,
          arrStartS: 2,
          arrEndS: 3,
          sourceInS: 2,
          sourceOutS: 3,
          originalArrStartS: 2,
          originalArrEndS: 3,
          originalSourceInS: 2,
          originalSourceOutS: 3,
        },
      ];

      const result = await editRenderMulti({
        cams: [
          {
            id: camId,
            file: videoBlob,
            masterStartS: 0,
            sourceDurationS: 6,
            kind: "video",
          },
        ],
        cuts: [],
        pills,
        masterDurationS: 3,
        audioFile: audioBlob,
        segments: [{ in: 0, out: 3 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1.0,
      });

      expect(result.output).not.toBeNull();
      const outBytes = result.output!;
      expect(outBytes.byteLength).toBeGreaterThan(1000);

      // Re-parse — pills span 3s of arr-time, output should be ~3s.
      const reparsed = await demuxVideoTrack(new Blob([outBytes as BlobPart]));
      expect(reparsed).not.toBeNull();
      expect(reparsed!.info.durationS).toBeGreaterThan(2.5);
      expect(reparsed!.info.durationS).toBeLessThan(3.5);

      // Audio is the studio tone (440 Hz) — verify zero-crossing rate
      // over a 1-second window.
      const audio = await decodeAudioToMonoPcm(new Blob([outBytes as BlobPart]), 22050);
      const window = audio.pcm.slice(11025, 11025 + 22050);
      let zc = 0;
      for (let i = 1; i < window.length; i++) {
        if (window[i - 1] <= 0 && window[i] > 0) zc++;
      }
      // 440 Hz → ~440 zero-crossings/s. Allow margin for encoder rounding.
      expect(zc).toBeGreaterThan(400);
      expect(zc).toBeLessThan(480);
    },
    120_000,
  );

  it(
    "two cams with cuts: alternates active cam and produces a valid MP4",
    async () => {
      const videoBlob = await (await fetch(MULTI_KEYFRAME_FIXTURE_URL)).blob();
      const audioBlob = makeSineWav(440, 2.0, 48000);

      const result = await editRenderMulti({
        cams: [
          {
            id: "A",
            file: videoBlob,
            masterStartS: 0,
            sourceDurationS: 6,
            kind: "video",
          },
          {
            id: "B",
            file: videoBlob,
            masterStartS: 0,
            sourceDurationS: 6,
            kind: "video",
          },
        ],
        // Switch from A → B at 1s.
        cuts: [
          { atTimeS: 0, camId: "A" },
          { atTimeS: 1, camId: "B" },
        ],
        masterDurationS: 2,
        audioFile: audioBlob,
        segments: [{ in: 0, out: 2 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1.0,
      });

      expect(result.output).not.toBeNull();
      const reparsed = await demuxVideoTrack(new Blob([result.output! as BlobPart]));
      expect(reparsed).not.toBeNull();
      expect(reparsed!.info.durationS).toBeGreaterThan(1.5);
      expect(reparsed!.info.durationS).toBeLessThan(2.5);
    },
    120_000,
  );
});
