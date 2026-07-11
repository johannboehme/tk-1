/**
 * Quick render: take a phone-recorded video and replace its audio track with
 * the offset/drift-corrected studio recording. Mirrors the backend's
 * `app/pipeline/render_quick.py` (stream-copy video, re-encode audio with
 * `atempo` + `adelay` + AAC).
 *
 * Pipeline:
 *   1. Demux the video file → encoded video chunks (passthrough) + decoder
 *      config (avcC for H.264).
 *   2. Decode the studio audio file → interleaved PCM, source sample rate.
 *   3. Apply drift stretch first, then offset (matches backend order:
 *      atempo runs before adelay in the filter chain).
 *   4. Encode PCM → AAC chunks via WebCodecs AudioEncoder.
 *   5. Mux video chunks + audio chunks into a fresh MP4 via mp4-muxer.
 */

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { decodeAudioToMonoPcm } from "../codec/webcodecs/audio-decode";
import { encodeAacFromPcm } from "../codec/webcodecs/audio-encode";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import {
  applyAudioOffsetInterleaved,
  applyDriftStretchInterleaved,
} from "./audio-fx";
import { createSingleFlight } from "./single-flight";

export interface QuickRenderInput {
  /** Phone-recorded video. We keep this video stream byte-for-byte. */
  videoFile: Blob | ArrayBuffer;
  /** Studio audio. Re-encoded with offset + drift applied. */
  audioFile: Blob | ArrayBuffer;
  /** Positive: studio is delayed in the video timeline. Negative: trimmed. */
  offsetMs: number;
  /** 1.0 = no drift. > 1.0 means studio audio gets stretched longer. */
  driftRatio: number;
  audioBitrateBps?: number;
}

export interface QuickRenderResult {
  output: Uint8Array;
  videoCodec: string;
  width: number;
  height: number;
  videoDurationS: number;
  audioSampleRate: number;
  audioChannelCount: number;
  /** Which codec backend produced the audio. */
  audioBackend: "webcodecs" | "ffmpeg-wasm";
}

async function decodeStudioAudioInterleaved(
  source: Blob | ArrayBuffer,
): Promise<{ pcm: Float32Array; sampleRate: number; channels: number }> {
  const buf = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const ctx = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
  const ch = decoded.numberOfChannels;
  const samplesPerChannel = decoded.length;
  const interleaved = new Float32Array(samplesPerChannel * ch);
  for (let c = 0; c < ch; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < samplesPerChannel; i++) {
      interleaved[i * ch + c] = channel[i];
    }
  }
  return {
    pcm: interleaved,
    sampleRate: decoded.sampleRate,
    channels: ch,
  };
}

/**
 * In-flight guard: a second quickRender while one is running would race
 * the first into the same OPFS output path (the slower one silently
 * wins) and interleave progress updates on the same render op. Reject
 * it up front instead — mirrors runEditRender's activeRenders check.
 */
const singleFlight = createSingleFlight(
  "A quick render is already in progress.",
);

export async function quickRender(input: QuickRenderInput): Promise<QuickRenderResult> {
  return singleFlight(() => quickRenderInner(input));
}

async function quickRenderInner(input: QuickRenderInput): Promise<QuickRenderResult> {
  // 1. Demux video.
  const video = await demuxVideoTrack(input.videoFile);
  if (!video) throw new Error("Quick render: video file has no video track.");

  // 2. Decode studio audio.
  const audio = await decodeStudioAudioInterleaved(input.audioFile);

  // 3. Apply drift, then offset.
  let pcm = audio.pcm;
  if (input.driftRatio !== 1.0) {
    pcm = applyDriftStretchInterleaved(pcm, audio.channels, input.driftRatio);
  }
  if (input.offsetMs !== 0) {
    pcm = applyAudioOffsetInterleaved(pcm, audio.channels, audio.sampleRate, input.offsetMs);
  }

  // 4. Encode AAC.
  const encoded = await encodeAacFromPcm(pcm, {
    numberOfChannels: audio.channels,
    sampleRate: audio.sampleRate,
    bitrateBps: input.audioBitrateBps ?? 192_000,
  });
  if (!encoded.description) {
    throw new Error("AudioEncoder produced no decoder description (esds bytes).");
  }

  // 5. Mux.
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width: video.info.width,
      height: video.info.height,
      frameRate: Math.round(video.info.fps),
    },
    audio: {
      // Use whatever codec the encoder actually produced. On most
      // browsers that's AAC (the requested default), but iOS Safari
      // falls back to Opus inside `encodeAudioFromPcm` — passing
      // "aac" here would mismatch the chunks and emit a silent track.
      codec: encoded.muxerCodec,
      numberOfChannels: encoded.numberOfChannels,
      sampleRate: encoded.sampleRate,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  const videoMeta = {
    decoderConfig: {
      codec: video.info.codec,
      codedWidth: video.info.width,
      codedHeight: video.info.height,
      description: video.info.description,
    },
  } as unknown as Parameters<Muxer<ArrayBufferTarget>["addVideoChunkRaw"]>[4];

  for (const c of video.chunks) {
    muxer.addVideoChunkRaw(
      c.data,
      c.isKey ? "key" : "delta",
      c.timestampUs,
      c.durationUs,
      videoMeta,
    );
  }

  const audioMeta = {
    decoderConfig: {
      codec: encoded.codec,
      sampleRate: encoded.sampleRate,
      numberOfChannels: encoded.numberOfChannels,
      description: encoded.description,
    },
  } as unknown as Parameters<Muxer<ArrayBufferTarget>["addAudioChunkRaw"]>[4];

  for (const c of encoded.chunks) {
    muxer.addAudioChunkRaw(c.data, c.type, c.timestampUs, c.durationUs, audioMeta);
  }

  muxer.finalize();
  const buffer = (muxer.target as ArrayBufferTarget).buffer;

  return {
    output: new Uint8Array(buffer),
    videoCodec: video.info.codec,
    width: video.info.width,
    height: video.info.height,
    videoDurationS: video.info.durationS,
    audioSampleRate: encoded.sampleRate,
    audioChannelCount: encoded.numberOfChannels,
    audioBackend: "webcodecs",
  };
}

// Imported for the type-only side effect — keeps decodeAudioToMonoPcm in the
// import graph for tests that use it elsewhere.
void decodeAudioToMonoPcm;
