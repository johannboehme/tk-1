/**
 * Contact Sheet — the source-pool below the Film Strip.
 *
 * A scrollable rail of Polaroid cards (one per accepted Triage chunk).
 * Click "+ ADD" on a Polaroid to insert that chunk at the current
 * insertion-cursor in the Film Strip; tap the Polaroid body to focus +
 * preview-loop the chunk.
 *
 * On mobile the Contact Sheet sits directly underneath the Film Strip
 * — the user's eye and finger don't have to travel.
 */
import { useMemo } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { effectiveBarsForChunk } from "../../local/arrange/arrange-store";
import { chunkSpectralColor } from "../../local/arrange/chunk-mel";
import { Polaroid } from "./Polaroid";

export function ContactSheet() {
  const jobId = useArrangeStore((s) => s.jobId);
  const chunks = useArrangeStore((s) => s.chunks);
  const cams = useArrangeStore((s) => s.cams);
  const selectedCamId = useArrangeStore((s) => s.selectedCamId);
  const arrangement = useArrangeStore((s) => s.arrangement);
  const insertChunkAtCursor = useArrangeStore((s) => s.insertChunkAtCursor);
  const seek = useArrangeStore((s) => s.seek);
  const setPlaying = useArrangeStore((s) => s.setPlaying);
  const focusItem = useArrangeStore((s) => s.focusItem);
  const seekToItem = useArrangeStore((s) => s.seekToItem);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const jobBeatsPerBar = useArrangeStore((s) => s.jobBeatsPerBar);
  const analysis = useArrangeStore((s) => s.analysis);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  // Derive usage from the arrangement reference — useMemo keeps the
  // returned object stable, so subscribers don't re-render every tick.
  const usageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of arrangement) {
      counts[item.chunkId] = (counts[item.chunkId] ?? 0) + 1;
    }
    return counts;
  }, [arrangement]);
  const acceptedChunks = chunks
    .filter((c) => c.accepted)
    .sort((a, b) => a.startMs - b.startMs);

  if (acceptedChunks.length === 0) {
    return (
      <section className="rounded-md border border-rule bg-paper-hi shadow-panel p-6 text-center">
        <p className="font-mono text-[11px] tracking-label uppercase text-ink-3">
          ◇ no accepted chunks — go back to triage to keep some
        </p>
      </section>
    );
  }

  return (
    <section className="flex-1 min-h-0 rounded-md border border-rule bg-paper-hi shadow-panel overflow-hidden flex flex-col">
      <header className="flex-none bg-paper-panel border-b border-rule px-3 py-2 flex items-center gap-2">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          ◇ Chunks · {acceptedChunks.length}
        </span>
        <span className="ml-auto font-mono text-[9px] tabular tracking-label uppercase text-ink-3 hidden sm:inline">
          drag to strip · or hit + ADD
        </span>
      </header>
      <div
        className="overflow-y-auto"
        style={{
          // Subtle paper-tone wash — the contact sheet is "mounted" on
          // a darker board, like a real darkroom contact print.
          background:
            "linear-gradient(180deg, #E8E1D0 0%, #DDD4BE 100%)",
        }}
      >
        {/* Wrap-grid so the polaroids fill the available width and
         *  height instead of forcing horizontal scroll. With ~124-px
         *  cards the 1456-px desktop fits ~10 across, mobile 2-3. */}
        <div className="flex flex-wrap items-stretch gap-3 px-3 py-3">
          {acceptedChunks.map((chunk, i) => {
            const bars = effectiveBarsForChunk(chunk, jobBpm, jobBeatsPerBar);
            const usage = usageCounts[chunk.id] ?? 0;
            const spectralColor = chunkSpectralColor(chunk, analysis);
            return (
              <Polaroid
                key={chunk.id}
                jobId={jobId}
                cam={cam}
                chunk={chunk}
                index={i}
                bars={bars}
                usage={usage}
                spectralColor={spectralColor}
                onAdd={() => {
                  insertChunkAtCursor(chunk.id);
                }}
                onPreview={() => {
                  // Click never changes the play state — if playback
                  // is paused, stay paused; if it's running, the seek
                  // re-routes it. This rule is global: no UI surface
                  // auto-starts playback on click.
                  const inArrangement = arrangement.find(
                    (a) => a.chunkId === chunk.id,
                  );
                  if (inArrangement) {
                    seekToItem(inArrangement.id);
                  } else {
                    focusItem(null);
                    seek(chunk.startMs / 1000);
                  }
                }}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
