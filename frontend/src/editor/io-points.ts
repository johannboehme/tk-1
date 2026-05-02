// Routing helpers for the I/O hotkeys (and the IN/OUT TransportBar buttons).
//
// I/O semantics depend on what's "in focus" on the timeline:
//   - loop region active → edit loop boundaries
//   - a video clip selected → edit that clip's source-trim (in/out)
//   - an image clip selected → edit that clip's master-pill edges
//   - otherwise → edit master trim (export region)
//
// Pure helpers: no store access, no React. The TransportBar reads the
// store imperatively and feeds the relevant slice in here.

import { Clip, ImageClip, VideoClip, clipRangeS, isImageClip, isVideoClip } from "./types";
import type { LoopRegion } from "./OffsetScheduler";

/** Image min-pill width — must match the clamp inside `setImageClipDuration`. */
const IMAGE_MIN_DURATION_S = 0.1;

export type IOTarget =
  | { kind: "loop" }
  | { kind: "master" }
  | { kind: "video"; clip: VideoClip }
  | { kind: "image"; clip: ImageClip };

export function classifyIOTarget(args: {
  loop: LoopRegion | null;
  selectedClipId: string | null;
  clips: Clip[];
}): IOTarget {
  if (args.loop) return { kind: "loop" };
  if (args.selectedClipId !== null) {
    const clip = args.clips.find((c) => c.id === args.selectedClipId);
    if (clip && isImageClip(clip)) return { kind: "image", clip };
    if (clip && isVideoClip(clip)) return { kind: "video", clip };
  }
  return { kind: "master" };
}

/** Master playhead → clip-source-time. Same convention as the
 *  video-trim drag handler in Timeline.tsx (anchor-relative, ignores
 *  driftRatio). */
export function videoSourceTimeAtPlayhead(clip: VideoClip, masterT: number): number {
  return masterT - clipRangeS(clip).anchorS;
}

/** Image I-point: left edge moves to playhead, right edge stays put.
 *  Mirrors the `image-resize-start` drag in Timeline.tsx. */
export function imageInAtPlayhead(
  clip: ImageClip,
  masterT: number,
): { startOffsetS: number; durationS: number } {
  const origRight = clip.startOffsetS + clip.durationS;
  const newLeft = Math.min(origRight - IMAGE_MIN_DURATION_S, masterT);
  return { startOffsetS: newLeft, durationS: origRight - newLeft };
}

/** Image O-point: right edge moves to playhead, left edge stays put.
 *  Returns the new durationS only (`setImageClipDuration` clamps the
 *  min-pill width). */
export function imageOutAtPlayhead(clip: ImageClip, masterT: number): number {
  return masterT - clip.startOffsetS;
}
