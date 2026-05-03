/**
 * Arrange-Phase (Step 2 von 3 für Long-Form-Session-Jobs).
 *
 * User sortiert die in Triage akzeptierten Chunks via Mini-Arranger,
 * darf duplizieren, sieht logische Timeline-Länge live.
 *
 * Placeholder für Phase 1: Routing + Job-State-Machine. Echte Arrange-UI
 * kommt in Phase 5 dazu.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { RuleStrip } from "../editor/components/RuleStrip";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";

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
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <span className="font-mono text-xs tracking-label uppercase text-ink-2">
            STEP 02 · ARRANGE · SEQUENCE
          </span>
          <RuleStrip count={32} className="text-rule flex-1 max-w-[220px]" />
        </div>
        <h1 className="font-display font-semibold text-[clamp(32px,4vw,52px)] leading-[1] tracking-tight text-ink">
          Order the cuts.<br />
          <span className="text-hot">Build the song.</span>
        </h1>
      </header>

      <div className="rounded-lg border-2 border-dashed border-rule bg-paper-hi p-8 mb-6 min-h-[320px] flex items-center justify-center">
        <div className="text-center max-w-md">
          <p className="font-mono text-xs tracking-label uppercase text-ink-3 mb-3">
            ◇ ARRANGE UI · UNDER CONSTRUCTION
          </p>
          <p className="text-ink-2 leading-relaxed">
            Hier landet der Mini-Arranger zum Sortieren / Duplizieren der
            Chunks. Placeholder für die Routing-Verkabelung.
          </p>
          {job && (
            <p className="font-mono text-[11px] text-ink-3 mt-4 tabular">
              Job: {job.title ?? job.id} · chunks={job.chunks?.length ?? 0}
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-between gap-3">
        <ChunkyButton
          variant="ghost"
          size="lg"
          onClick={() => navigate(jobRoutePath(id, "triage"))}
        >
          ← Back to Triage
        </ChunkyButton>
        <ChunkyButton
          variant="primary"
          size="lg"
          onClick={() => navigate(jobRoutePath(id, "edit"))}
          className="min-w-[200px]"
        >
          Continue → Editor
        </ChunkyButton>
      </div>
    </main>
  );
}
