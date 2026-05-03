/**
 * Route wrapper that ensures all of a job's `FileSystemFileHandle`-
 * backed assets have read permission before rendering the wrapped
 * page (Editor / JobPage / RenderScreen). When a handle's permission
 * has lapsed (typical after a page reload), shows a single-click
 * "Allow access" prompt — the browser only grants
 * `requestPermission()` from within a user gesture.
 *
 * No-op for v2 / OPFS-backed jobs: `checkReadPermission` returns
 * "n/a" / "granted" for OPFS sources, the gate flips to ready
 * immediately.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { jobsDb } from "../storage/jobs-db";
import {
  PermissionGate,
  type AssetWithName,
} from "./PermissionGate";

export function JobPermissionRoute({ children }: { children: React.ReactNode }) {
  const { id = "" } = useParams<{ id: string }>();
  const [assets, setAssets] = useState<AssetWithName[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const job = await jobsDb.getJob(id);
      if (cancelled) return;
      if (!job) {
        setMissing(true);
        return;
      }
      const list: AssetWithName[] = [];
      if (job.audioSource) {
        list.push({ source: job.audioSource, name: job.audioFilename });
      }
      for (const v of job.videos ?? []) {
        if (v.source) list.push({ source: v.source, name: v.filename });
      }
      setAssets(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Memoise so PermissionGate's `useEffect` dep doesn't re-trigger on
  // every parent render once we've resolved the list.
  const memoised = useMemo(() => assets ?? [], [assets]);

  if (missing) {
    return (
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="border-l-2 border-danger pl-3 py-2 text-sm text-danger font-mono">
          Job not found.
        </div>
      </main>
    );
  }
  if (assets === null) return null; // initial load, no flash
  return <PermissionGate assets={memoised}>{children}</PermissionGate>;
}
