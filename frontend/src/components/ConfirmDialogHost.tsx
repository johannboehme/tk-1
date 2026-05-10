/**
 * Host component for `confirmDestructive` / `chooseSplitReplacement` /
 * `confirmMergeReplaceAll`. Mount once at the app root — it renders one
 * modal at a time from the queued request stack.
 *
 * Styling follows the rest of the UI: paper-hi card with a hot/danger
 * destructive button. Esc cancels, Enter confirms (destructive flavour
 * only — split/merge intentionally require an explicit click to avoid
 * accidental data-shape choices).
 */
import { useEffect } from "react";
import {
  useConfirmStore,
  type ConfirmRequest,
  type DestructiveRequest,
  type SplitRequest,
  type MergeRequest,
} from "../lib/confirm";

export default function ConfirmDialogHost() {
  const requests = useConfirmStore((s) => s.requests);
  const resolve = useConfirmStore((s) => s.resolve);
  const top: ConfirmRequest | undefined = requests[0];

  useEffect(() => {
    if (!top) return;
    function onKey(e: KeyboardEvent) {
      if (!top) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (top.kind === "split") resolve(top.id, null);
        else resolve(top.id, false);
      } else if (e.key === "Enter" && top.kind === "destructive") {
        e.preventDefault();
        resolve(top.id, true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, resolve]);

  if (!top) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/40 backdrop-blur-sm px-4"
      onClick={(e) => {
        // Backdrop click cancels.
        if (e.target === e.currentTarget) {
          if (top.kind === "split") resolve(top.id, null);
          else resolve(top.id, false);
        }
      }}
    >
      <div className="max-w-md w-full bg-paper-hi border border-rule rounded-lg shadow-panel p-6 flex flex-col gap-4">
        <h2
          id="confirm-dialog-title"
          className="font-display text-lg text-ink"
        >
          {top.title}
        </h2>
        <div className="text-sm text-ink-2 leading-relaxed">{top.body}</div>
        {top.kind === "destructive" && (
          <DestructiveButtons req={top} resolve={resolve} />
        )}
        {top.kind === "split" && (
          <SplitButtons req={top} resolve={resolve} />
        )}
        {top.kind === "merge" && (
          <MergeButtons req={top} resolve={resolve} />
        )}
      </div>
    </div>
  );
}

function DestructiveButtons({
  req,
  resolve,
}: {
  req: DestructiveRequest;
  resolve: (id: number, value: boolean) => void;
}) {
  return (
    <div className="flex gap-2 justify-end">
      <button
        type="button"
        onClick={() => resolve(req.id, false)}
        className="h-9 px-3 rounded-md border border-rule bg-paper-deep text-ink-2 font-display tracking-label uppercase text-xs hover:bg-paper hover:text-ink"
        autoFocus
      >
        {req.cancelLabel}
      </button>
      <button
        type="button"
        onClick={() => resolve(req.id, true)}
        className="h-9 px-3 rounded-md bg-danger text-paper-hi font-display tracking-label uppercase text-xs hover:opacity-90"
      >
        {req.destructiveLabel}
      </button>
    </div>
  );
}

function SplitButtons({
  req,
  resolve,
}: {
  req: SplitRequest;
  resolve: (id: number, value: "a" | "b" | "both" | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => resolve(req.id, "both")}
        className="h-10 px-3 rounded-md bg-hot text-paper font-display tracking-label uppercase text-xs hover:opacity-90"
        autoFocus
      >
        Replace with both (A then B)
      </button>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => resolve(req.id, "a")}
          className="flex-1 h-9 px-3 rounded-md border border-rule bg-paper-deep text-ink font-display tracking-label uppercase text-xs hover:bg-paper"
        >
          Replace with A only
        </button>
        <button
          type="button"
          onClick={() => resolve(req.id, "b")}
          className="flex-1 h-9 px-3 rounded-md border border-rule bg-paper-deep text-ink font-display tracking-label uppercase text-xs hover:bg-paper"
        >
          Replace with B only
        </button>
      </div>
      <button
        type="button"
        onClick={() => resolve(req.id, null)}
        className="h-9 px-3 rounded-md text-ink-2 font-display tracking-label uppercase text-xs hover:text-ink"
      >
        Cancel split
      </button>
    </div>
  );
}

function MergeButtons({
  req,
  resolve,
}: {
  req: MergeRequest;
  resolve: (id: number, value: boolean) => void;
}) {
  return (
    <div className="flex gap-2 justify-end">
      <button
        type="button"
        onClick={() => resolve(req.id, false)}
        className="h-9 px-3 rounded-md border border-rule bg-paper-deep text-ink-2 font-display tracking-label uppercase text-xs hover:bg-paper hover:text-ink"
        autoFocus
      >
        Cancel merge
      </button>
      <button
        type="button"
        onClick={() => resolve(req.id, true)}
        className="h-9 px-3 rounded-md bg-hot text-paper font-display tracking-label uppercase text-xs hover:opacity-90"
      >
        Replace all with merged
      </button>
    </div>
  );
}
