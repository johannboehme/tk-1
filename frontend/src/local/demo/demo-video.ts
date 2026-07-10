/**
 * Demo-cam synthesis: renders an animated test-card style video on an
 * OffscreenCanvas, encodes it with WebCodecs (`StreamingVideoEncoder`),
 * gives it an audio track sliced out of the demo song's PCM, and muxes
 * both into a plain MP4 via mp4-muxer — the same encode/mux stack the
 * app's own render pipeline uses.
 *
 * The audio slice is the load-bearing part: each cam's track is the
 * master song starting at that cam's `songStartS`, so the real sync
 * pipeline finds a genuine offset, exactly like a phone that started
 * recording mid-song.
 */

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { StreamingVideoEncoder } from "../codec/webcodecs/video-encode";
import { encodeAudioFromPcm } from "../codec/webcodecs/audio-encode";
import type { DemoCamTheme, DemoVideoSpec } from "./demo-project";

export interface SynthesizeDemoVideoOptions {
  spec: DemoVideoSpec;
  /** Cam recording length (seconds). */
  durationS: number;
  /** Mono PCM of the FULL song; the cam's track is sliced from it. */
  songPcm: Float32Array;
  sampleRate: number;
  bpm: number;
  width?: number;
  height?: number;
  fps?: number;
  onProgress?: (frac: number) => void;
}

/** Cut this cam's audio out of the song: starts at `startS`, runs for
 *  `durationS`, clamped to the song's end. Pure — unit-tested. */
export function sliceCamAudio(
  songPcm: Float32Array,
  sampleRate: number,
  startS: number,
  durationS: number,
): Float32Array {
  const start = Math.min(Math.max(0, Math.round(startS * sampleRate)), songPcm.length);
  const end = Math.min(start + Math.max(0, Math.round(durationS * sampleRate)), songPcm.length);
  return songPcm.subarray(start, end);
}

export async function synthesizeDemoVideo(
  opts: SynthesizeDemoVideoOptions,
): Promise<File> {
  const width = opts.width ?? 640;
  const height = opts.height ?? 360;
  const fps = opts.fps ?? 24;
  const frameCount = Math.max(1, Math.round(opts.durationS * fps));
  const onProgress = opts.onProgress ?? (() => {});

  // --- audio: slice of the master song, AAC (Opus fallback inside) ---
  const camPcm = sliceCamAudio(
    opts.songPcm,
    opts.sampleRate,
    opts.spec.songStartS,
    opts.durationS,
  );
  const audio = await encodeAudioFromPcm(camPcm, {
    numberOfChannels: 1,
    sampleRate: opts.sampleRate,
    bitrateBps: 96_000,
  });

  // --- video: canvas-rendered frames through the WebCodecs encoder ---
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("demo-video: 2D context unavailable");

  const encoder = new StreamingVideoEncoder({
    width,
    height,
    frameRate: fps,
    bitrateBps: 1_500_000,
  });

  const frameDurationUs = Math.round(1_000_000 / fps);
  for (let i = 0; i < frameCount; i++) {
    const tS = i / fps;
    drawDemoFrame(ctx, {
      width,
      height,
      tS,
      songTimeS: opts.spec.songStartS + tS,
      bpm: opts.bpm,
      label: opts.spec.label,
      theme: opts.spec.theme,
    });
    const frame = new VideoFrame(canvas, {
      timestamp: i * frameDurationUs,
      duration: frameDurationUs,
    });
    // Keyframe every 2 s keeps the file seekable for the editor preview.
    encoder.pushFrame(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    // Backpressure: don't let the encode queue grow unbounded.
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 0));
    }
    if (i % fps === 0) onProgress(i / frameCount);
  }
  const video = await encoder.finish();
  onProgress(1);

  // --- mux (same recipe as render/quick.ts) ---
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: video.muxerCodec,
      width,
      height,
      frameRate: fps,
    },
    audio: {
      codec: audio.muxerCodec,
      numberOfChannels: audio.numberOfChannels,
      sampleRate: audio.sampleRate,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  const videoMeta = {
    decoderConfig: {
      codec: video.codec,
      codedWidth: width,
      codedHeight: height,
      description: video.description,
    },
  } as unknown as Parameters<Muxer<ArrayBufferTarget>["addVideoChunkRaw"]>[4];
  for (const c of video.chunks) {
    muxer.addVideoChunkRaw(c.data, c.type, c.timestampUs, c.durationUs, videoMeta);
  }

  const audioMeta = {
    decoderConfig: {
      codec: audio.codec,
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.numberOfChannels,
      description: audio.description,
    },
  } as unknown as Parameters<Muxer<ArrayBufferTarget>["addAudioChunkRaw"]>[4];
  for (const c of audio.chunks) {
    muxer.addAudioChunkRaw(c.data, c.type, c.timestampUs, c.durationUs, audioMeta);
  }

  muxer.finalize();
  const buffer = (muxer.target as ArrayBufferTarget).buffer;
  return new File([buffer], opts.spec.filename, { type: "video/mp4" });
}

interface DemoFrameParams {
  width: number;
  height: number;
  /** Time within this cam's recording. */
  tS: number;
  /** Time within the song (drives the beat clock). */
  songTimeS: number;
  bpm: number;
  label: string;
  theme: DemoCamTheme;
}

/** One animated frame: solid backdrop, beat-pulsing disc, bar:beat
 *  counter, a block bouncing in song time, and the cam label. Everything
 *  is a pure function of song time, so both cams visibly move in lockstep
 *  once sync has lined them up. */
function drawDemoFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  p: DemoFrameParams,
): void {
  const { width: w, height: h, theme } = p;
  const beat = 60 / p.bpm;
  const beatIdx = Math.floor(p.songTimeS / beat);
  const beatPhase = (p.songTimeS % beat) / beat; // 0..1 within the beat

  // Backdrop
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  // Ruler ticks along the bottom, scrolling with song time.
  ctx.fillStyle = theme.ink;
  const tickSpacing = w / 16;
  const scroll = (p.songTimeS / beat) * tickSpacing;
  for (let x = -(scroll % tickSpacing); x < w; x += tickSpacing) {
    ctx.fillRect(Math.round(x), h - 18, 2, 10);
  }

  // Beat-pulsing disc — big on the beat, eases out.
  const pulse = 1 - Math.min(1, beatPhase * 2.2);
  const baseR = h * 0.16;
  ctx.beginPath();
  ctx.arc(w * 0.32, h * 0.46, baseR * (1 + 0.35 * pulse), 0, Math.PI * 2);
  ctx.fillStyle = theme.accent;
  ctx.fill();

  // Block bouncing across in song time (one sweep per 4 beats).
  const sweep = (p.songTimeS / (beat * 4)) % 1;
  const bx = w * 0.12 + sweep * w * 0.72;
  const by = h * 0.72 - Math.abs(Math.sin(p.songTimeS * Math.PI * 2)) * h * 0.1;
  ctx.fillStyle = theme.ink;
  ctx.fillRect(Math.round(bx), Math.round(by), 26, 26);

  // Header: label plate + bar:beat counter + timecode.
  ctx.fillStyle = theme.ink;
  ctx.font = `700 ${Math.round(h * 0.09)}px ui-monospace, monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`TK-1 DEMO · ${p.label}`, Math.round(w * 0.05), Math.round(h * 0.07));

  const bar = Math.floor(beatIdx / 4) + 1;
  const beatInBar = (beatIdx % 4) + 1;
  ctx.font = `500 ${Math.round(h * 0.06)}px ui-monospace, monospace`;
  ctx.fillText(
    `${String(bar).padStart(2, "0")}:${beatInBar} · ${p.songTimeS.toFixed(2)}s`,
    Math.round(w * 0.05),
    Math.round(h * 0.19),
  );
}
