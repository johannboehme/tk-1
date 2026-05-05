/**
 * Pure helper that translates a sync op's `stage` + `pct` (+ optional
 * `error`) into a UI-ready view: which master phase is active, which
 * cam is active and in which sub-stage, plus a local 0..1 fraction for
 * the active cam (so its row can show a meaningful sub-progress bar).
 *
 * Mirrors the stage strings emitted by `runSync` in `local/jobs.ts`:
 *   - "queued" / "loading" / "decoding-studio-audio"      → master decoding
 *   - "syncing-{camId}"                                    → that cam is syncing
 *   - "frames-{camId}"                                     → that cam is in frames
 *   - "analyzing-audio"                                    → master analyzing
 *   - "detecting-chunks"                                   → master detecting (long-form only)
 *
 * Caller passes `done: true` after the sync op clears (the project's
 * data — `videos[].sync` — is the source of truth there). Errors come
 * via the `error` field on the op.
 *
 * The progress fractions assume runSync's band layout: cams share the
 * 5..95 pct range equally (band = 90 / numCams, cam-i starts at 5 + i*band).
 */

export type MasterState =
  | "pending"
  | "decoding"
  | "analyzing"
  | "detecting"
  | "done"
  | "failed";
export type CamState = "pending" | "syncing" | "frames" | "done" | "failed";

export interface CamProgressView {
  id: string;
  state: CamState;
  /** Local 0..1 progress within this cam's band; meaningful when state is
   *  "syncing" or "frames", otherwise 0. */
  fraction: number;
}

export interface SyncProgressView {
  master: MasterState;
  cams: CamProgressView[];
  globalPct: number;
}

interface BuildInput {
  stage: string;
  pct: number;
  cams: ReadonlyArray<{ id: string }>;
  /** True when the sync data is fully on the job — cleared op + all
   *  cams have a sync result. UI shows everything as done. */
  done?: boolean;
  /** Set when the op carries an error. Active cam (if any) is
   *  highlighted as failed; cams before it are kept as done. */
  error?: string;
}

/** Match "syncing-{id}" or "frames-{id}". Returns { kind, camId } or null. */
function parseCamStage(stage: string): { kind: "syncing" | "frames"; camId: string } | null {
  const m = /^(syncing|frames)-(.+)$/.exec(stage);
  if (!m) return null;
  return { kind: m[1] as "syncing" | "frames", camId: m[2] };
}

export function buildSyncProgressView(input: BuildInput): SyncProgressView {
  const { stage, pct, cams, done, error } = input;
  const numCams = cams.length;

  // Terminal: sync data is on the job.
  if (done) {
    return {
      master: "done",
      cams: cams.map((c) => ({ id: c.id, state: "done", fraction: 0 })),
      globalPct: 100,
    };
  }

  if (error) {
    const cam = parseCamStage(stage);
    if (!cam) {
      // No specific cam — master-level failure.
      return {
        master: "failed",
        cams: cams.map((c) => ({ id: c.id, state: "pending", fraction: 0 })),
        globalPct: pct,
      };
    }
    const idx = cams.findIndex((c) => c.id === cam.camId);
    return {
      master: idx >= 0 ? "done" : "failed",
      cams: cams.map((c, i) => ({
        id: c.id,
        state:
          idx < 0
            ? "pending"
            : i < idx
              ? "done"
              : i === idx
                ? "failed"
                : "pending",
        fraction: 0,
      })),
      globalPct: pct,
    };
  }

  // Master phases.
  if (
    stage === "queued" ||
    stage === "loading" ||
    stage === "decoding-studio-audio"
  ) {
    const masterState: MasterState =
      stage === "queued" ? "pending" : "decoding";
    return {
      master: masterState,
      cams: cams.map((c) => ({ id: c.id, state: "pending", fraction: 0 })),
      globalPct: pct,
    };
  }

  if (stage === "analyzing-audio") {
    return {
      master: "analyzing",
      cams: cams.map((c) => ({ id: c.id, state: "done", fraction: 0 })),
      globalPct: pct,
    };
  }

  // Long-form Triage: silence + per-chunk BPM run on the master audio
  // after the per-cam stages. Cams are already done by then.
  if (stage === "detecting-chunks") {
    return {
      master: "detecting",
      cams: cams.map((c) => ({ id: c.id, state: "done", fraction: 0 })),
      globalPct: pct,
    };
  }

  // Per-cam stages.
  const cam = parseCamStage(stage);
  if (cam) {
    const idx = cams.findIndex((c) => c.id === cam.camId);
    if (idx < 0) {
      // Unknown cam id (legacy job, schema drift). Bail out gracefully:
      // master prep done, no per-cam state — keep cams pending.
      return {
        master: "done",
        cams: cams.map((c) => ({ id: c.id, state: "pending", fraction: 0 })),
        globalPct: pct,
      };
    }

    // runSync band: cams share 5..95% equally.
    const band = numCams > 0 ? 90 / numCams : 0;
    const camStartPct = 5 + idx * band;
    const fraction =
      band > 0 ? Math.max(0, Math.min(1, (pct - camStartPct) / band)) : 0;

    return {
      master: "done",
      cams: cams.map((c, i) => {
        if (i < idx) return { id: c.id, state: "done", fraction: 0 };
        if (i === idx)
          return { id: c.id, state: cam.kind, fraction };
        return { id: c.id, state: "pending", fraction: 0 };
      }),
      globalPct: pct,
    };
  }

  // Fallback: unknown stage string. Don't crash — show pending.
  return {
    master: "pending",
    cams: cams.map((c) => ({ id: c.id, state: "pending", fraction: 0 })),
    globalPct: pct,
  };
}
