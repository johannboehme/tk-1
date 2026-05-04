/**
 * ArrangeInspector — surfaces the focused frame's metadata and offers
 * shift / duplicate / drop actions. When nothing is focused, shows a
 * hint about how to focus a frame.
 */
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { effectiveBarsForChunk } from "../../local/arrange/arrange-store";

export function ArrangeInspector() {
  const focusedItemId = useArrangeStore((s) => s.focusedItemId);
  const arrangement = useArrangeStore((s) => s.arrangement);
  const chunks = useArrangeStore((s) => s.chunks);
  const shiftItem = useArrangeStore((s) => s.shiftItem);
  const duplicateItem = useArrangeStore((s) => s.duplicateItem);
  const removeItem = useArrangeStore((s) => s.removeItem);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const jobBeatsPerBar = useArrangeStore((s) => s.jobBeatsPerBar);

  const focusedItem = focusedItemId
    ? arrangement.find((a) => a.id === focusedItemId) ?? null
    : null;
  const focusedChunk = focusedItem
    ? chunks.find((c) => c.id === focusedItem.chunkId) ?? null
    : null;
  const focusedIdx = focusedItem
    ? arrangement.findIndex((a) => a.id === focusedItem.id)
    : -1;

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <header className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          ◇ Frame
        </span>
        {focusedItem && (
          <span className="font-mono text-[10px] tabular text-ink-3">
            {focusedIdx + 1} / {arrangement.length}
          </span>
        )}
      </header>
      {!focusedItem || !focusedChunk ? (
        <div className="p-4 text-center font-mono text-[11px] tracking-label uppercase text-ink-3">
          ◇ tap a frame to inspect
        </div>
      ) : (
        <Body
          chunkId={focusedChunk.id}
          bars={effectiveBarsForChunk(focusedChunk, jobBpm, jobBeatsPerBar)}
          startMs={focusedChunk.startMs}
          endMs={focusedChunk.endMs}
          bpm={jobBpm ?? undefined}
          onShiftLeft={() => shiftItem(focusedItem.id, -1)}
          onShiftRight={() => shiftItem(focusedItem.id, +1)}
          onDuplicate={() => duplicateItem(focusedItem.id)}
          onRemove={() => removeItem(focusedItem.id)}
          canShiftLeft={focusedIdx > 0}
          canShiftRight={focusedIdx < arrangement.length - 1}
        />
      )}
    </section>
  );
}

function Body({
  chunkId,
  bars,
  startMs,
  endMs,
  bpm,
  onShiftLeft,
  onShiftRight,
  onDuplicate,
  onRemove,
  canShiftLeft,
  canShiftRight,
}: {
  chunkId: string;
  bars: number;
  startMs: number;
  endMs: number;
  bpm: number | undefined;
  onShiftLeft: () => void;
  onShiftRight: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  canShiftLeft: boolean;
  canShiftRight: boolean;
}) {
  const lengthS = (endMs - startMs) / 1000;
  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <KV label="Source" value={chunkId.replace(/^chunk-/, "")} />
        <KV label="Bars" value={`≈ ${bars.toFixed(1)}`} />
        <KV label="Length" value={`${lengthS.toFixed(1)}s`} />
        <KV label="BPM" value={bpm ? bpm.toFixed(0) : "—"} />
      </div>
      <div className="border-t border-rule pt-2">
        <div className="font-display tracking-label uppercase text-[9px] text-ink-3 mb-1">
          Reorder
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <ChunkyButton
            variant="secondary"
            size="xs"
            onClick={onShiftLeft}
            disabled={!canShiftLeft}
            title="Shift left · Shift+←"
          >
            ◀ shift
          </ChunkyButton>
          <ChunkyButton
            variant="secondary"
            size="xs"
            onClick={onShiftRight}
            disabled={!canShiftRight}
            title="Shift right · Shift+→"
          >
            shift ▶
          </ChunkyButton>
        </div>
      </div>
      <div className="border-t border-rule pt-2 grid grid-cols-2 gap-1.5">
        <ChunkyButton
          variant="secondary"
          size="xs"
          onClick={onDuplicate}
          title="Duplicate next to this frame"
        >
          Duplicate
        </ChunkyButton>
        <ChunkyButton
          variant="secondary"
          size="xs"
          onClick={onRemove}
          title="Remove · Backspace"
        >
          Drop
        </ChunkyButton>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="font-display tracking-label uppercase text-[9px] text-ink-3">
        {label}
      </span>
      <span className="font-mono tabular text-ink text-right truncate">
        {value}
      </span>
    </>
  );
}
