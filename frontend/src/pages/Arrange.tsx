/**
 * Arrange-Phase (Step 2 von 3 für Long-Form-Session-Jobs).
 *
 * User sortiert die in Triage akzeptierten Chunks via Mini-Arranger,
 * darf duplizieren, sieht logische Timeline-Länge live.
 *
 * Placeholder für Phase 1: Routing + Job-State-Machine. Echte Arrange-UI
 * kommt in Phase 5 dazu.
 *
 * Layout: Full-bleed (TopBar wird in App.tsx ausgeblendet). Wiederverwendet
 * den PhaseStrip von Triage.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";
import { PhaseStrip } from "./Triage";

export default function Arrange() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    jobsDb.getJob(id).then((j) => {
      if (active) setJob(j ?? null);
    });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <div className="flex-1 flex flex-col min-h-0 paper-bg">
      <PhaseStrip
        phase="arrange"
        jobTitle={job?.title ?? null}
        jobId={id}
        onBack={() => navigate(jobRoutePath(id, "triage"))}
        onContinue={() => navigate(jobRoutePath(id, "edit"))}
        continueLabel="Continue → Editor"
      />

      <main className="flex-1 min-h-0 grid place-items-center px-4 py-6">
        <div className="text-center max-w-md text-ink-3">
          <p className="font-mono text-xs tracking-label uppercase mb-3">
            ◇ Arrange · coming next
          </p>
          <p className="text-ink-2 leading-relaxed text-sm">
            The mini-arranger lands here once Triage is fully signed
            off. For now, navigate back to keep curating.
          </p>
        </div>
      </main>
    </div>
  );
}
