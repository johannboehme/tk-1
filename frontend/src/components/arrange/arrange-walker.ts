/**
 * Pure decision core for the Arrange audio walker.
 *
 * `useArrangeAudio`'s RAF loop calls `planWalkerTick` once per frame
 * and executes whatever it returns. Keeping the branching here — free
 * of WebAudio/DOM — makes the walker's two playback modes testable:
 *
 *   arrangement mode — walk `arrangement[]` item to item by ID,
 *     arm a crossfade-hop shortly before each chunk's master-time end,
 *     stop after the last item.
 *
 *   preview mode — `previewChunkId` set: loop a pool chunk's
 *     master-time range (startMs..endMs) so unarranged chunks can be
 *     auditioned before committing them to the strip. The loop-hop
 *     also arms when `t` already ran PAST the chunk end (remaining
 *     <= 0), so a derailed playhead snaps back instead of free-running
 *     through raw master audio.
 */
import type { ArrangementItem, Chunk } from "../../storage/jobs-db";

export type WalkerPlan =
  /** Nothing to do this tick. */
  | { kind: "none" }
  /** Playback lost its subject (tracked item / preview chunk gone) —
   *  pause safely. */
  | { kind: "stop" }
  /** Preview loop: crossfade-hop back to the chunk start. */
  | { kind: "arm-loop"; hopToS: number; remainingS: number }
  /** Arrangement walk: crossfade-hop to the next item's chunk start. */
  | { kind: "arm-advance"; hopToS: number; remainingS: number; nextItemId: string }
  /** Last arrangement item: schedule a pause at the chunk end. */
  | { kind: "arm-end"; remainingS: number };

export function planWalkerTick(args: {
  isPlaying: boolean;
  /** True while a crossfade-hop is already armed — no new decisions. */
  hasArmed: boolean;
  /** Master-audio time (seconds) of the active element. */
  tS: number;
  arrangement: readonly ArrangementItem[];
  chunks: readonly Chunk[];
  currentItemId: string | null;
  previewChunkId: string | null;
  /** Arm the hop when less than this many seconds remain. */
  leadTimeS: number;
}): WalkerPlan {
  if (!args.isPlaying || args.hasArmed) return { kind: "none" };

  const chunkById = new Map(args.chunks.map((c) => [c.id, c]));

  // ─── Preview mode: transient pool-chunk loop ──────────────────────
  if (args.previewChunkId) {
    const ck = chunkById.get(args.previewChunkId);
    if (!ck) return { kind: "stop" };
    const remaining = ck.endMs / 1000 - args.tS;
    if (remaining < args.leadTimeS) {
      return {
        kind: "arm-loop",
        hopToS: ck.startMs / 1000,
        remainingS: Math.max(0, remaining),
      };
    }
    return { kind: "none" };
  }

  // ─── Arrangement mode ─────────────────────────────────────────────
  const items = args.arrangement;
  const idx = args.currentItemId
    ? items.findIndex((a) => a.id === args.currentItemId)
    : -1;
  // Walker lost the item it was tracking (deleted while playing, or
  // arrangement reset to empty). Bail safely.
  if (idx === -1) return { kind: "stop" };

  const curChunk = chunkById.get(items[idx].chunkId);
  if (!curChunk) return { kind: "none" };
  const remaining = curChunk.endMs / 1000 - args.tS;
  if (!(remaining > 0 && remaining < args.leadTimeS)) return { kind: "none" };

  const nextItem = items[idx + 1];
  const nextChunk = nextItem ? chunkById.get(nextItem.chunkId) : null;
  if (nextItem && nextChunk) {
    return {
      kind: "arm-advance",
      hopToS: nextChunk.startMs / 1000,
      remainingS: remaining,
      nextItemId: nextItem.id,
    };
  }
  return { kind: "arm-end", remainingS: remaining };
}
