/**
 * useAutoPersist — debounced save of editor state into the LocalJob row.
 *
 * What gets persisted (300 ms after the last change):
 *  - per-cam: `syncOverrideMs`, `startOffsetS`, `selectedCandidateIdx`
 *  - `cuts[]` (multi-cam markers)
 *  - `trim` { in, out }
 *  - `bpm` (value + manualOverride flag — survives reload so the user
 *    doesn't lose their override after a refresh)
 *  - `audioStartNudgeS` — user's beat-grid anchor correction
 *  - `beatsPerBar`, `barOffsetBeats` — time signature + pickup
 *  - `ui` { snapMode, lanesLocked }
 *
 * Skipped during the initial load — we only fire when the user actually
 * changes something. Wiring point: mount once in the editor shell after
 * `loadJob()` resolved.
 *
 * Leaving the editor never discards a pending write (#120): unmount and
 * `pagehide` flush it, and `flushEditorStateNow()` lets submit paths
 * persist the full state before navigating.
 */
import { useEffect } from "react";
import { useEditorStore } from "./store";
import {
  isImageAsset,
  jobsDb,
  type LocalJob,
  type MediaAsset,
} from "../storage/jobs-db";
import { isVideoClip } from "../core/types";
import { confirmDestructive } from "../lib/confirm";

const DEBOUNCE_MS = 300;

/** Pure helper: derive the persist-patch for `updateJob` from an editor
 *  state snapshot and the current LocalJob row. Exported for testing.
 *
 *  Handles both video assets (sync override + candidate idx) and image
 *  assets (only startOffsetS to persist). */
export function buildPersistPatch(
  s: ReturnType<typeof useEditorStore.getState>,
  job: LocalJob,
): Partial<LocalJob> {
  const updatedVideos: MediaAsset[] = (job.videos ?? []).map((v): MediaAsset => {
    const clip = s.clips.find((c) => c.id === v.id);
    if (!clip) return v;
    if (isImageAsset(v)) {
      return {
        ...v,
        startOffsetS: clip.startOffsetS,
        rotation: clip.rotation,
        flipX: clip.flipX,
        flipY: clip.flipY,
        viewportTransform: clip.viewportTransform,
      };
    }
    if (!isVideoClip(clip)) return v; // shouldn't happen, defensive
    return {
      ...v,
      syncOverrideMs: clip.syncOverrideMs,
      startOffsetS: clip.startOffsetS,
      selectedCandidateIdx: clip.selectedCandidateIdx,
      trimInS: clip.trimInS,
      trimOutS: clip.trimOutS,
      rotation: clip.rotation,
      flipX: clip.flipX,
      flipY: clip.flipY,
      viewportTransform: clip.viewportTransform,
    };
  });

  const bpm = s.jobMeta?.bpm
    ? {
        value: s.jobMeta.bpm.value,
        confidence: s.jobMeta.bpm.confidence,
        phase: s.jobMeta.bpm.phase,
        manualOverride: s.jobMeta.bpm.manualOverride,
      }
    : undefined;

  return {
    videos: updatedVideos,
    cuts: s.cuts,
    bpm,
    audioStartNudgeS: s.jobMeta?.audioStartNudgeS ?? 0,
    beatsPerBar: s.jobMeta?.beatsPerBar ?? 4,
    barOffsetBeats: s.jobMeta?.barOffsetBeats ?? 0,
    ui: { snapMode: s.ui.snapMode, lanesLocked: s.ui.lanesLocked },
    trim: { in: s.trim.in, out: s.trim.out },
    fx: s.fx,
    // GradeParams is structurally a flat number map; the storage record is
    // the same shape with an index signature.
    colorGrade: s.colorGrade as unknown as Record<string, number>,
    filterSlots: s.filterSlots,
    audioVolume: s.audioVolume,
    exportSpec: s.exportSpec,
    // Persist user-edited pills so a refresh / re-open keeps move + trim
    // gestures. Direct-mode jobs leave pills empty; storing [] here is
    // a no-op round-trip.
    pills: s.pills,
    // Stamp the persisted job so the next load skips the master→timeline
    // migration on cuts/fx. The runtime is now timeline-time-native and
    // every write here goes out in that axis.
    editorSchema: "v2-timeline",
  };
}

type EditorStoreState = ReturnType<typeof useEditorStore.getState>;

/**
 * The single source of truth for "which store slices feed the persisted
 * patch". `persistRelevantChanged` is derived from this list so it can
 * not drift from what `buildPersistPatch` writes — when you add a field
 * to the patch, add its selector here (and the round-trip test will
 * remind you).
 */
const PERSIST_SELECTORS: ReadonlyArray<(s: EditorStoreState) => unknown> = [
  (s) => s.clips,
  (s) => s.cuts,
  (s) => s.pills,
  (s) => s.trim,
  (s) => s.ui.snapMode,
  (s) => s.ui.lanesLocked,
  (s) => s.jobMeta?.bpm,
  (s) => s.jobMeta?.audioStartNudgeS,
  (s) => s.jobMeta?.beatsPerBar,
  (s) => s.jobMeta?.barOffsetBeats,
  (s) => s.fx,
  (s) => s.colorGrade,
  (s) => s.filterSlots,
  (s) => s.audioVolume,
  (s) => s.exportSpec,
];

/** Pure dirty-check for the auto-persist subscription: did this store
 *  transition touch anything `buildPersistPatch` writes? Derived from
 *  `PERSIST_SELECTORS` — see there. Exported for tests. */
export function persistRelevantChanged(
  state: EditorStoreState,
  prev: EditorStoreState,
): boolean {
  return PERSIST_SELECTORS.some((sel) => sel(state) !== sel(prev));
}

/** Backoff schedule for failed writes (#124). A transient IndexedDB
 *  failure (QuotaExceededError, connection closed by another tab) used
 *  to lose the edit permanently when the user made no further change —
 *  the common tweak-one-knob-then-export case. Bounded so a dead DB
 *  doesn't get hammered forever; after the last attempt the failure
 *  surfaces as an editor notice instead of a console-only warn. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ---------------------------------------------------------------------------
// Cross-tab write guard (#129)
//
// Auto-persist used to be an unversioned read-modify-write: any tab's flush
// rewrote the FULL editing surface from its own in-memory store, so the same
// project open in two tabs silently clobbered edits last-write-wins. Every
// flush now goes through `jobsDb.updateJobGuarded`, a compare-and-set on the
// row's `editRev`. Each mounted editor tracks the revision it last wrote in
// an edit session; when the row moved underneath it (another tab saved),
// the write is REFUSED, saving pauses, and the user chooses explicitly:
// overwrite with this tab's version, or keep the other tab's edits.
// ---------------------------------------------------------------------------

interface EditSession {
  /** `editRev` this tab last wrote (or loaded). Null until seeded. */
  rev: number | null;
  /** True → a conflict was detected and saving is paused until the
   *  user picks a side via the conflict dialog. */
  conflicted: boolean;
}

const editSessions = new Map<string, EditSession>();

/** Test-only: forget all cross-tab edit sessions. */
export function resetEditSessionsForTest(): void {
  editSessions.clear();
}

/** Per-job flush serialization: a debounced flush and an explicit
 *  `flushEditorStateNow` racing each other would CAS with the same
 *  expected rev and one would spuriously "conflict". Chaining flushes
 *  keeps rev tracking coherent within the tab. */
const flushChains = new Map<string, Promise<void>>();

function enqueueFlush(jobId: string, run: () => Promise<void>): Promise<void> {
  const prev = flushChains.get(jobId) ?? Promise.resolve();
  const next = prev.then(run);
  flushChains.set(jobId, next);
  return next;
}

/**
 * A guarded write was refused: the row's `editRev` moved underneath this
 * tab. Pause saving and ask the user which version wins. One dialog per
 * conflict — further flush attempts are blocked by `conflicted` until
 * resolution.
 */
async function handleRevConflict(
  jobId: string,
  currentRev: number,
): Promise<void> {
  const session = editSessions.get(jobId);
  if (session) {
    if (session.conflicted) return;
    session.conflicted = true;
  }
  console.error(
    `auto-persist: job ${jobId} was saved from another tab (rev ${currentRev}) — saving paused`,
  );
  const overwrite = await confirmDestructive({
    title: "Project changed in another tab",
    body:
      "This project was saved from another tab while it was open here. " +
      "To protect those newer edits, saving from this tab is paused. " +
      "You can overwrite them with this tab's version, or keep them — " +
      "then reload this tab to pick them up.",
    destructiveLabel: "Overwrite with this tab's version",
    cancelLabel: "Keep the other tab's edits",
  });
  if (!overwrite) return; // saving stays paused for this tab
  const live = editSessions.get(jobId) ?? session;
  if (live) {
    live.rev = currentRev;
    live.conflicted = false;
  }
  await persistSnapshot(jobId, useEditorStore.getState());
}

/**
 * Persist one editor-state snapshot into the job row, retrying failed
 * writes on a bounded backoff (#124). Shared by the debounced
 * auto-persist, the flush-on-unmount/pagehide paths, and
 * `flushEditorStateNow`. The snapshot is captured by the caller so a
 * flush that races unmount still writes what the user last saw; a retry
 * upgrades to the store's current state when it still holds this job,
 * so it never overwrites newer edits with a stale snapshot.
 *
 * Writes go through the `editRev` compare-and-set (#129); a refused
 * write pauses saving and raises the conflict dialog instead of
 * clobbering another tab's newer edits. Flushes for the same job are
 * serialized via `enqueueFlush`.
 *
 * `isStale` is re-checked after every await: the debounced path uses it
 * to bail when the hook was cleaned up mid-flight (the cleanup itself
 * runs a snapshot-based final flush instead).
 */
function persistSnapshot(
  jobId: string,
  s: EditorStoreState,
  isStale: () => boolean = () => false,
): Promise<void> {
  return enqueueFlush(jobId, () => persistSnapshotNow(jobId, s, isStale));
}

async function persistSnapshotNow(
  jobId: string,
  s: EditorStoreState,
  isStale: () => boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    // Prefer the freshest state for this job — matters on retries, where
    // the user may have edited again since the failed attempt.
    const live = useEditorStore.getState();
    const snap = live.jobMeta?.id === jobId ? live : s;
    if (!snap.jobMeta || snap.jobMeta.id !== jobId) return;
    const session = editSessions.get(jobId);
    if (session?.conflicted) return; // saving is paused (#129)
    try {
      const job = await jobsDb.getJob(jobId);
      if (!job || isStale()) return;
      // Expected revision: what this tab last wrote, seeded from the row
      // itself on the very first flush (or when no session exists —
      // plain single-shot CAS against the current row).
      const expectedRev = session?.rev ?? job.editRev ?? 0;
      const result = await jobsDb.updateJobGuarded(
        jobId,
        expectedRev,
        buildPersistPatch(snap, job),
      );
      if (!result.ok) {
        // Another tab moved the row — never clobber silently (#129).
        void handleRevConflict(jobId, result.currentRev);
        return;
      }
      if (session) session.rev = result.job.editRev ?? expectedRev + 1;
      return;
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error("auto-persist failed permanently:", err);
        // Loud, user-visible signal — silent data loss is the one thing
        // this hook exists to prevent.
        try {
          const cur = useEditorStore.getState();
          if (cur.jobMeta?.id === jobId) {
            cur.pushNotice("Saving failed — recent edits may be lost on reload");
          }
        } catch {
          // notice is best-effort
        }
        return;
      }
      console.warn(
        `auto-persist failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}), retrying:`,
        err,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      if (isStale()) return;
    }
  }
}

/**
 * Immediately persist the current editor state for `jobId` (#120).
 *
 * Callers that leave the editor programmatically (EXPORT navigates to
 * /render right away) await this instead of racing the 300 ms debounce
 * — it writes the full `buildPersistPatch`, not a hand-picked subset.
 * Any pending debounced timer becomes a harmless double-write, and the
 * mounted hook drops its timer on the next scheduled change anyway.
 */
export async function flushEditorStateNow(jobId: string): Promise<void> {
  cancelPendingFlush?.();
  await persistSnapshot(jobId, useEditorStore.getState());
}

/** Set by the mounted hook so `flushEditorStateNow` can cancel a pending
 *  debounce timer (avoiding a duplicate write right after the explicit
 *  flush). Null when no editor is mounted. */
let cancelPendingFlush: (() => void) | null = null;

/**
 * One-time warning when the same project is detected in another tab at
 * mount (#129). Backed by the Web Locks API where available; the
 * rev-guard above catches the clobber case regardless. "Go back" leaves
 * the editor; "Edit here anyway" continues under the rev-guard's watch.
 */
async function warnProjectOpenElsewhere(): Promise<void> {
  const editHere = await confirmDestructive({
    title: "Project is open in another tab",
    body:
      "This project is already open in another tab. Edits made in two " +
      "tabs can overwrite each other — close the other tab before " +
      "editing here. This tab will refuse to overwrite edits saved " +
      "from elsewhere.",
    destructiveLabel: "Edit here anyway",
    cancelLabel: "Go back",
  });
  if (!editHere) window.history.back();
}

export function useAutoPersist(jobId: string | null): void {
  useEffect(() => {
    if (!jobId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let firstFire = true;

    // Fresh cross-tab edit session (#129). Replaces any stale session
    // from a previous mount; the baseline rev is seeded from the row so
    // a foreign write between load and the first flush is caught too.
    const session: EditSession = { rev: null, conflicted: false };
    editSessions.set(jobId, session);
    void jobsDb
      .getJob(jobId)
      .then((job) => {
        if (job && session.rev === null) session.rev = job.editRev ?? 0;
      })
      .catch(() => undefined);

    // Proactive second-tab detection via Web Locks (#129): hold an
    // exclusive per-project lock for the lifetime of this editor; if
    // it's already held, another tab has this project open — warn now
    // instead of at the first refused write.
    let releaseLock: (() => void) | null = null;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks && typeof locks.request === "function") {
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      void Promise.resolve(
        locks.request(
          `tk1-project-${jobId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              void warnProjectOpenElsewhere();
              return;
            }
            await held; // hold until unmount
          },
        ),
      ).catch(() => undefined);
    }

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    cancelPendingFlush = clearTimer;

    const flush = () => {
      timer = null;
      if (cancelled) return;
      void persistSnapshot(jobId, useEditorStore.getState(), () => cancelled);
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    // Flush, don't discard, when the pending write would otherwise be
    // lost (#120): tab close / navigation fires pagehide, and unmount
    // covers in-app navigation (EXPORT, back). The snapshot is taken
    // synchronously so a store reset right after unmount can't blank it.
    const flushPendingNow = () => {
      if (timer === null) return;
      clearTimer();
      void persistSnapshot(jobId, useEditorStore.getState());
    };
    window.addEventListener("pagehide", flushPendingNow);

    const unsub = useEditorStore.subscribe((state, prev) => {
      // Skip while the store hasn't been loaded yet for this jobId.
      if (!state.jobMeta || state.jobMeta.id !== jobId) return;

      // Skip the very first transition into "loaded" — that's loadJob()
      // hydrating the store from IDB, not a user edit.
      if (firstFire) {
        firstFire = false;
        return;
      }

      if (persistRelevantChanged(state, prev)) {
        schedule();
      }
    });

    return () => {
      window.removeEventListener("pagehide", flushPendingNow);
      unsub();
      flushPendingNow();
      cancelled = true;
      if (cancelPendingFlush === clearTimer) cancelPendingFlush = null;
      releaseLock?.();
      // The session intentionally stays in the map: the final flush
      // above still consults it, and a later remount replaces it with
      // a freshly-seeded one.
    };
  }, [jobId]);
}
