/**
 * One-click demo project: synthesizes a small song plus two "cam"
 * videos entirely in the browser (no bundled media, no downloads) and
 * feeds them through the NORMAL `createJob` path, so the user lands in
 * the same sync → editor flow their own footage would take.
 *
 * Cam B starts one bar into the song — the sync stage has a real
 * offset to find, exactly like a phone that started recording late.
 */

import type { Capabilities } from "../../core/capabilities";
import type { PickedAsset } from "../asset-source";
import { createJob } from "../jobs";
import { DEMO_SONG, renderDemoSongPcm, songDurationS, beatDurationS } from "./demo-song";
import { encodeWavPcm16 } from "./wav-encode";
import { synthesizeDemoVideo } from "./demo-video";

export interface DemoCamTheme {
  bg: string;
  accent: string;
  ink: string;
}

export interface DemoVideoSpec {
  label: string;
  filename: string;
  /** Where this cam starts within the song (seconds). */
  songStartS: number;
  theme: DemoCamTheme;
}

/** One bar at the demo tempo — cam B's late start. */
const ONE_BAR_S = DEMO_SONG.beatsPerBar * beatDurationS(DEMO_SONG);

export const DEMO_CAM_SPECS: readonly DemoVideoSpec[] = [
  {
    label: "CAM A",
    filename: "demo-cam-a.mp4",
    songStartS: 0,
    theme: { bg: "#1a1816", accent: "#ff4d00", ink: "#f2ede2" },
  },
  {
    label: "CAM B",
    filename: "demo-cam-b.mp4",
    songStartS: ONE_BAR_S,
    theme: { bg: "#10141c", accent: "#2f6bff", ink: "#e8ecf5" },
  },
];

/** The demo needs WebCodecs encoders (video + audio) and OffscreenCanvas.
 *  Browsers without them (Safari/Firefox today) get a disabled affordance
 *  with a pointer to Chromium. */
export function canSynthesizeDemo(caps: Capabilities): boolean {
  return (
    caps.videoEncoder &&
    caps.audioEncoder &&
    typeof OffscreenCanvas !== "undefined"
  );
}

export interface DemoProgress {
  stage: "song" | "cam" | "job";
  /** Human-readable bit for the button label (cam label etc.). */
  detail: string;
}

export interface CreateDemoJobOptions {
  onProgress?: (p: DemoProgress) => void;
}

/**
 * Synthesize the demo assets and register the job. Returns the job id;
 * sync starts automatically inside `createJob`, so callers navigate to
 * `/job/:id` just like the manual upload flow does.
 */
export async function createDemoJob(
  opts: CreateDemoJobOptions = {},
): Promise<string> {
  const onProgress = opts.onProgress ?? (() => {});

  onProgress({ stage: "song", detail: "song" });
  const songPcm = renderDemoSongPcm(DEMO_SONG);
  const wav = encodeWavPcm16(songPcm, 1, DEMO_SONG.sampleRate);
  const audioPick: PickedAsset = {
    file: new File([wav], "demo-song.wav", { type: "audio/wav" }),
    handle: null,
  };

  const durS = songDurationS(DEMO_SONG);
  const videoPicks: PickedAsset[] = [];
  for (const spec of DEMO_CAM_SPECS) {
    onProgress({ stage: "cam", detail: spec.label });
    const file = await synthesizeDemoVideo({
      spec,
      durationS: durS - spec.songStartS,
      songPcm,
      sampleRate: DEMO_SONG.sampleRate,
      bpm: DEMO_SONG.bpm,
    });
    videoPicks.push({ file, handle: null });
  }

  onProgress({ stage: "job", detail: "job" });
  return await createJob(videoPicks, audioPick, {
    title: "Demo session",
    mode: "direct",
  });
}
