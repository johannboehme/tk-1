import { describe, it, expect } from "vitest";
import { editRenderMulti } from "./edit";
import { SharedReelSink } from "./render-sink";
import { streamEncodeAudioWithSegments } from "../codec/webcodecs/audio-encode";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import { decodeAudioToMonoPcm } from "../codec/webcodecs/audio-decode";

const FIXTURE_URL = "/__test_fixtures__/video-multi-keyframe.mp4";

function sineMono(freqHz: number, durationS: number, sampleRate: number): Float32Array {
  const n = Math.floor(durationS * sampleRate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return a;
}

function zeroCrossings(pcm: Float32Array, from: number, to: number): number {
  let zc = 0;
  for (let i = Math.max(1, from); i < to && i < pcm.length; i++) {
    if (pcm[i - 1] <= 0 && pcm[i] > 0) zc++;
  }
  return zc;
}

describe("reel render — SharedReelSink concat (real Chromium)", () => {
  it(
    "concatenates two members into one MP4 at the common stage, gapless audio",
    async () => {
      const videoBlob = await (await fetch(FIXTURE_URL)).blob();
      const SR = 48000;
      const FPS = 30;
      const stage = { w: 640, h: 360 };

      // One global, gapless mono audio track: 2 s @440 Hz then 2 s @880 Hz.
      const partA = sineMono(440, 2.0, SR);
      const partB = sineMono(880, 2.0, SR);
      const global = new Float32Array(partA.length + partB.length);
      global.set(partA, 0);
      global.set(partB, partA.length);

      const sink = new SharedReelSink({
        width: stage.w,
        height: stage.h,
        fps: FPS,
        videoCodec: "h264",
        audioCodec: "aac",
        audioChannels: 1,
        audioSampleRate: SR,
        // No `output` → in-memory ArrayBufferTarget, read back at finalize.
      });

      // Audio: encode the global track once into the shared sink.
      let audioMeta:
        | Parameters<SharedReelSink["addAudioChunk"]>[4]
        | undefined;
      await streamEncodeAudioWithSegments(global, [], {
        numberOfChannels: 1,
        sampleRate: SR,
        codec: "aac",
        onChunk: (chunk, description) => {
          if (!audioMeta && description) {
            audioMeta = {
              decoderConfig: {
                codec: "mp4a.40.2",
                sampleRate: SR,
                numberOfChannels: 1,
                description,
              },
            } as unknown as Parameters<SharedReelSink["addAudioChunk"]>[4];
          }
          sink.addAudioChunk(
            chunk.data,
            chunk.type,
            chunk.timestampUs,
            chunk.durationUs,
            audioMeta,
          );
        },
      });

      const frameDurationUs = Math.round(1_000_000 / FPS);
      const memberFrames = Math.round(2.0 * FPS);

      // Member 0 — first 2 s, no offset.
      sink.setVideoTimeOffset(0);
      await editRenderMulti({
        cams: [
          { id: "m0", file: videoBlob, masterStartS: 0, sourceDurationS: 6, kind: "video" },
        ],
        cuts: [],
        masterDurationS: 2,
        segments: [{ in: 0, out: 2 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1,
        outputFps: FPS,
        skipAudio: true,
        sink,
        outer: { stage },
      });

      // Member 1 — next 2 s, offset by member 0's frame count.
      sink.setVideoTimeOffset(memberFrames * frameDurationUs);
      await editRenderMulti({
        cams: [
          { id: "m1", file: videoBlob, masterStartS: 0, sourceDurationS: 6, kind: "video" },
        ],
        cuts: [],
        masterDurationS: 2,
        segments: [{ in: 0, out: 2 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1,
        outputFps: FPS,
        skipAudio: true,
        sink,
        outer: { stage },
      });

      const res = sink.finalize();
      expect(res.output).not.toBeNull();
      const bytes = res.output!;
      expect(bytes.byteLength).toBeGreaterThan(1000);

      // Re-parse: one MP4 at the reel stage, ~4 s long.
      const reparsed = await demuxVideoTrack(new Blob([bytes as BlobPart]));
      expect(reparsed).not.toBeNull();
      expect(reparsed!.info.width).toBe(stage.w);
      expect(reparsed!.info.height).toBe(stage.h);
      expect(reparsed!.info.durationS).toBeGreaterThan(3.5);
      expect(reparsed!.info.durationS).toBeLessThan(4.5);

      // Audio ordering: 440 Hz in the first second, 880 Hz after 2.5 s.
      const audio = await decodeAudioToMonoPcm(new Blob([bytes as BlobPart]), 22050);
      const zcA = zeroCrossings(audio.pcm, 0, 22050);
      expect(zcA).toBeGreaterThan(400);
      expect(zcA).toBeLessThan(480);
      const zcB = zeroCrossings(audio.pcm, Math.floor(2.5 * 22050), Math.floor(3.5 * 22050));
      expect(zcB).toBeGreaterThan(840);
      expect(zcB).toBeLessThan(920);
    },
    120_000,
  );

  it(
    "both members are fully present + decodable end-to-end (frame count)",
    async () => {
      const videoBlob = await (await fetch(FIXTURE_URL)).blob();
      const SR = 48000;
      const FPS = 30;
      const stage = { w: 640, h: 360 };

      const global = sineMono(440, 4.0, SR);
      const sink = new SharedReelSink({
        width: stage.w,
        height: stage.h,
        fps: FPS,
        videoCodec: "h264",
        audioCodec: "aac",
        audioChannels: 1,
        audioSampleRate: SR,
      });
      let meta: Parameters<SharedReelSink["addAudioChunk"]>[4] | undefined;
      await streamEncodeAudioWithSegments(global, [], {
        numberOfChannels: 1,
        sampleRate: SR,
        codec: "aac",
        onChunk: (c, d) => {
          if (!meta && d) {
            meta = {
              decoderConfig: { codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 1, description: d },
            } as unknown as Parameters<SharedReelSink["addAudioChunk"]>[4];
          }
          sink.addAudioChunk(c.data, c.type, c.timestampUs, c.durationUs, meta);
        },
      });

      const frameDurationUs = Math.round(1_000_000 / FPS);
      const memberFrames = Math.round(2.0 * FPS);
      for (let k = 0; k < 2; k++) {
        sink.setVideoTimeOffset(k * memberFrames * frameDurationUs);
        await editRenderMulti({
          cams: [{ id: `m${k}`, file: videoBlob, masterStartS: 0, sourceDurationS: 6, kind: "video" }],
          cuts: [],
          masterDurationS: 2,
          segments: [{ in: 0, out: 2 }],
          overlays: [],
          offsetMs: 0,
          driftRatio: 1,
          outputFps: FPS,
          skipAudio: true,
          sink,
          outer: { stage },
        });
      }
      const res = sink.finalize();
      const reparsed = await demuxVideoTrack(new Blob([res.output! as BlobPart]));
      expect(reparsed).not.toBeNull();

      // Decode EVERY chunk — both members' frames must come out, ~120 total.
      let decoded = 0;
      const dec = new VideoDecoder({ output: (f) => { decoded++; f.close(); }, error: () => {} });
      dec.configure({
        codec: reparsed!.info.codec,
        codedWidth: reparsed!.info.width,
        codedHeight: reparsed!.info.height,
        description: reparsed!.info.description,
      });
      for (const c of reparsed!.chunks) {
        dec.decode(new EncodedVideoChunk({
          type: c.isKey ? "key" : "delta",
          timestamp: c.timestampUs,
          duration: c.durationUs,
          data: c.data,
        }));
      }
      await dec.flush();
      dec.close();
      // 2 members × 2s × 30fps = 120 frames. Allow small encoder margin.
      expect(decoded).toBeGreaterThan(112);
      expect(reparsed!.chunks.length).toBeGreaterThan(112);
    },
    120_000,
  );

  it(
    "a single member passes through at the common stage",
    async () => {
      const videoBlob = await (await fetch(FIXTURE_URL)).blob();
      const SR = 48000;
      const FPS = 30;
      const stage = { w: 480, h: 480 };

      const sink = new SharedReelSink({
        width: stage.w,
        height: stage.h,
        fps: FPS,
        videoCodec: "h264",
        audioCodec: "aac",
        audioChannels: 1,
        audioSampleRate: SR,
      });

      const global = sineMono(440, 1.5, SR);
      let meta: Parameters<SharedReelSink["addAudioChunk"]>[4] | undefined;
      await streamEncodeAudioWithSegments(global, [], {
        numberOfChannels: 1,
        sampleRate: SR,
        codec: "aac",
        onChunk: (chunk, description) => {
          if (!meta && description) {
            meta = {
              decoderConfig: {
                codec: "mp4a.40.2",
                sampleRate: SR,
                numberOfChannels: 1,
                description,
              },
            } as unknown as Parameters<SharedReelSink["addAudioChunk"]>[4];
          }
          sink.addAudioChunk(chunk.data, chunk.type, chunk.timestampUs, chunk.durationUs, meta);
        },
      });

      sink.setVideoTimeOffset(0);
      await editRenderMulti({
        cams: [
          { id: "only", file: videoBlob, masterStartS: 0, sourceDurationS: 6, kind: "video" },
        ],
        cuts: [],
        masterDurationS: 1.5,
        segments: [{ in: 0, out: 1.5 }],
        overlays: [],
        offsetMs: 0,
        driftRatio: 1,
        outputFps: FPS,
        skipAudio: true,
        sink,
        outer: { stage },
      });

      const res = sink.finalize();
      const reparsed = await demuxVideoTrack(new Blob([res.output! as BlobPart]));
      expect(reparsed).not.toBeNull();
      expect(reparsed!.info.width).toBe(stage.w);
      expect(reparsed!.info.height).toBe(stage.h);
      expect(reparsed!.info.durationS).toBeGreaterThan(1.2);
      expect(reparsed!.info.durationS).toBeLessThan(1.8);
    },
    120_000,
  );
});
