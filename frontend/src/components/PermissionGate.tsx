/**
 * Re-grant overlay for `FileSystemFileHandle`-backed jobs.
 *
 * When a user reopens a project after a page reload, the browser may
 * have lost the read permission for their original media files (the
 * permission state goes from `granted` → `prompt` once the
 * tab/handle ages out). The browser only allows
 * `handle.requestPermission()` from within a user gesture, so we
 * gate the editor / job page on a click that fires the prompt.
 *
 * The gate is a no-op for v2 / OPFS-backed jobs (everything resolves
 * to `granted`).
 */

import { useEffect, useState } from "react";
import {
  type AssetSource,
  checkReadPermission,
  requestReadPermission,
} from "../local/asset-source";

export interface AssetWithName {
  source: AssetSource;
  name: string;
}

export interface PermissionGateProps {
  /** All assets the page wants to read. The gate will check each and
   *  prompt for any that aren't granted. */
  assets: AssetWithName[];
  /** Rendered once every asset is granted. */
  children: React.ReactNode;
}

type GateState =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "needs-grant"; pending: AssetWithName[] }
  | { kind: "denied"; denied: AssetWithName[] };

export function PermissionGate({ assets, children }: PermissionGateProps) {
  const [state, setState] = useState<GateState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pending: AssetWithName[] = [];
      for (const a of assets) {
        const p = await checkReadPermission(a.source);
        if (p === "prompt") pending.push(a);
        else if (p === "denied") {
          if (!cancelled) setState({ kind: "denied", denied: [a] });
          return;
        }
      }
      if (cancelled) return;
      setState(pending.length === 0 ? { kind: "ready" } : { kind: "needs-grant", pending });
    })();
    return () => {
      cancelled = true;
    };
  }, [assets]);

  if (state.kind === "checking") return null;
  if (state.kind === "ready") return <>{children}</>;
  if (state.kind === "denied") {
    return (
      <DeniedView
        denied={state.denied}
        onRetry={() => setState({ kind: "checking" })}
      />
    );
  }
  return (
    <NeedsGrantView
      pending={state.pending}
      onGranted={() => setState({ kind: "ready" })}
      onDenied={(d) => setState({ kind: "denied", denied: d })}
    />
  );
}

function NeedsGrantView({
  pending,
  onGranted,
  onDenied,
}: {
  pending: AssetWithName[];
  onGranted: () => void;
  onDenied: (denied: AssetWithName[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const grantAll = async () => {
    setBusy(true);
    const denied: AssetWithName[] = [];
    for (const a of pending) {
      const p = await requestReadPermission(a.source);
      if (p !== "granted") denied.push(a);
    }
    setBusy(false);
    if (denied.length > 0) onDenied(denied);
    else onGranted();
  };
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full bg-paper-hi border border-rule rounded-lg p-6 flex flex-col gap-4">
        <h1 className="font-display text-2xl text-ink">Re-grant file access</h1>
        <p className="text-sm text-ink-2 leading-relaxed">
          Your browser doesn't keep file permissions across reloads.
          Click below to re-allow this project to read its media files
          from your disk — the bytes never leave your machine.
        </p>
        <ul className="flex flex-col gap-1 text-xs text-ink-2 font-mono">
          {pending.map((a) => (
            <li
              key={a.name}
              className="px-3 h-9 flex items-center bg-paper-deep border border-rule rounded"
            >
              {a.name}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={grantAll}
          disabled={busy}
          className="h-11 rounded-md bg-hot text-paper font-display tracking-label uppercase text-sm hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "…" : `Allow access (${pending.length})`}
        </button>
      </div>
    </main>
  );
}

function DeniedView({
  denied,
  onRetry,
}: {
  denied: AssetWithName[];
  onRetry: () => void;
}) {
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full bg-paper-hi border-l-2 border-danger pl-4 py-4 flex flex-col gap-3">
        <h1 className="font-display text-xl text-ink">File access denied</h1>
        <p className="text-sm text-ink-2 leading-relaxed">
          Without read access we can't open this project. Files we
          need:
        </p>
        <ul className="text-xs text-ink-2 font-mono">
          {denied.map((d) => (
            <li key={d.name}>· {d.name}</li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onRetry}
          className="self-start font-mono text-xs text-cobalt hover:underline tracking-label uppercase"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
