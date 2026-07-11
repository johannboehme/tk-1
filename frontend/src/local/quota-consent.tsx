/**
 * Consent dialog for the quota guard (#64). Separated from lifecycle.ts
 * so the domain module stays JSX-free; the dialog itself renders through
 * the global `<ConfirmDialogHost>` via the imperative confirm store.
 */
import { confirmDestructive } from "../lib/confirm";
import type { PruneCandidate } from "./lifecycle";

export function formatBytesShort(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Ask the user whether the planned projects may be deleted to make room.
 * Resolves `true` only on an explicit "Delete …" click; Esc, backdrop
 * click, and "Keep everything" all resolve `false`.
 */
export function promptQuotaPrune(args: {
  plan: ReadonlyArray<PruneCandidate>;
  usageBytes: number;
  quotaBytes: number;
}): Promise<boolean> {
  const { plan, usageBytes, quotaBytes } = args;
  const pct = Math.min(100, Math.round((usageBytes / quotaBytes) * 100));
  const freeable = plan.reduce((sum, p) => sum + p.bytes, 0);
  return confirmDestructive({
    title: "Storage is nearly full",
    body: (
      <div className="flex flex-col gap-3">
        <p>
          TK-1's browser storage is at about {pct}% of its quota. To make
          room for the new project, the oldest finished projects can be
          deleted — including their rendered videos and all edits.
        </p>
        <ul className="flex flex-col gap-1 border border-rule rounded-md p-3 bg-paper max-h-40 overflow-auto">
          {plan.map((p) => (
            <li
              key={p.id}
              className="flex items-baseline justify-between gap-3 font-mono text-xs"
            >
              <span className="truncate text-ink">{p.title || p.id}</span>
              <span className="tabular shrink-0 text-ink-2">
                {formatBytesShort(p.bytes)} ·{" "}
                {new Date(p.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
        <p>
          Frees up to {formatBytesShort(freeable)}. If you keep everything,
          the upload may fail with a storage error — you can also free
          space yourself by deleting projects from History.
        </p>
      </div>
    ),
    destructiveLabel:
      plan.length === 1 ? "Delete 1 project" : `Delete ${plan.length} projects`,
    cancelLabel: "Keep everything",
  });
}
