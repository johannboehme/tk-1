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
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { effectiveBarsForChunk } from "../../local/arrange/arrange-store";
import { Polaroid } from "./Polaroid";

export function ContactSheet() {
  const jobId = useArrangeStore((s) => s.jobId);
  const chunks = useArrangeStore((s) => s.chunks);
  const cams = useArrangeStore((s) => s.cams);
  const selectedCamId = useArrangeStore((s) => s.selectedCamId);
  const insertChunkAtCursor = useArrangeStore((s) => s.insertChunkAtCursor);
  const seek = useArrangeStore((s) => s.seek);
  const setPlaying = useArrangeStore((s) => s.setPlaying);
  const focusItem = useArrangeStore((s) => s.focusItem);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  const usageCounts = useArrangeStore((s) => s.usageCounts());
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
    <section className="rounded-md border border-rule bg-paper-hi shadow-panel overflow-hidden">
      <header className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center gap-2">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          ◇ Contact sheet
        </span>
        <span className="font-mono text-[10px] tabular text-ink-3">
          {acceptedChunks.length} chunks
        </span>
        <span className="ml-auto font-mono text-[9px] tabular tracking-label uppercase text-ink-3 hidden sm:inline">
          + ADD inserts at cursor
        </span>
      </header>
      <div
        className="overflow-x-auto overflow-y-hidden"
        style={{
          // Subtle paper-tone wash — the contact sheet is "mounted" on
          // a darker board, like a real darkroom contact print.
          background:
            "linear-gradient(180deg, #E8E1D0 0%, #DDD4BE 100%)",
        }}
      >
        <div className="flex items-stretch gap-3 px-3 py-3 min-w-max">
          {acceptedChunks.map((chunk, i) => {
            const bars = effectiveBarsForChunk(chunk);
            const usage = usageCounts[chunk.id] ?? 0;
            return (
              <Polaroid
                key={chunk.id}
                jobId={jobId}
                cam={cam}
                chunk={chunk}
                index={i}
                bars={bars}
                usage={usage}
                onAdd={() => {
                  insertChunkAtCursor(chunk.id);
                }}
                onPreview={() => {
                  // Tap the body = focus + preview-loop:
                  // jump the playhead to chunk start and start playing.
                  // The audio hook will handle wrapping the loop region.
                  seek(chunk.startMs / 1000);
                  setPlaying(true);
                  focusItem(null);
                }}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
