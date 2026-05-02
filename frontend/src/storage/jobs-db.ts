/**
 * IndexedDB-Wrapper für lokale Job-Metadaten.
 *
 * Mediadaten (Video, Audio, Render-Output) leben in OPFS (siehe ./opfs.ts).
 * Hier liegen nur strukturierte Daten: Status, Sync-Result, Edit-Spec,
 * Progress, Timing.
 */

import { openDB, type IDBPDatabase } from "idb";
import { migrateV1ToV2 } from "./migrations";

export interface MatchCandidate {
  offsetMs: number;
  confidence: number;
  overlapFrames: number;
}

export interface SyncResult {
  offsetMs: number;
  driftRatio: number;
  confidence: number;
  warning?: string;
  /** Top-K alternative offsets returned by the WASM matcher. The first entry
   *  mirrors offsetMs (the chosen primary). Optional for backward-compat with
   *  Jobs synced before this field existed. */
  candidates?: MatchCandidate[];
}

/**
 * Eine Video-Quelle innerhalb eines Multi-Video-Jobs (V2-Schema).
 *
 * Mehrere Videos teilen sich ein Master-Audio. Jedes Video hat seinen eigenen
 * Sync-Versatz und seine eigene Cam-Farbe für die Timeline-Visualisierung.
 */
export interface VideoAsset {
  /** Discriminator. Optional + defaults to "video" so existing rows pre-V3
   *  (no kind field) keep working without a DB migration. */
  kind?: "video";
  /** Stabile Cam-ID (cam-1, cam-2, …). Bleibt zwischen Sessions gleich. */
  id: string;
  /** Original-Dateiname vom User (für Anzeige in der UI). */
  filename: string;
  /** OPFS-Pfad der Mediadatei. Explizit gespeichert, weil Migration und neue
   * Uploads unterschiedliche Konventionen nutzen. */
  opfsPath: string;
  /** Cam-Farbe für PROGRAM-Strip + Lane-Header (deterministisch beim Upload). */
  color: string;
  sync?: SyncResult;
  durationS?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** OPFS-Pfad zur extrahierten Thumbnail-Strip-Datei (frames.webp). */
  framesPath?: string;
  // ---- Editor-state, persisted via auto-save ----
  /** User-nudge (ms) on top of sync.offsetMs. */
  syncOverrideMs?: number;
  /** Drag-on-timeline offset (seconds). */
  startOffsetS?: number;
  /** Index into sync.candidates of the user-selected primary. */
  selectedCandidateIdx?: number;
  /** Per-clip trim from the source-time start (seconds). Defaults to 0
   *  when absent — full source from frame 0. */
  trimInS?: number;
  /** Per-clip trim end (seconds, in source-time). Defaults to durationS
   *  when absent — full source to the end. */
  trimOutS?: number;
  /** User-applied rotation (degrees, V1: 0/90/180/270). Default 0. */
  rotation?: number;
  /** Mirror the cam horizontally / vertically. Defaults false. */
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element Stage placement (cover-fit + scale + translate). */
  viewportTransform?: {
    scale: number;
    x: number;
    y: number;
  };
}

/**
 * Standbild-Asset auf der Master-Timeline. Hat keine Audiospur, keine
 * Sync-Kandidaten, kein Drift — nur eine User-gewählte Dauer. Wird über
 * die gleichen Cuts (cam-id-basiert) als Programm-Quelle eingeblendet.
 */
export interface ImageAsset {
  kind: "image";
  /** Stabile ID, gleicher Namespace wie VideoAsset (cam-1, cam-2, …). */
  id: string;
  filename: string;
  opfsPath: string;
  color: string;
  width?: number;
  height?: number;
  /** User-gewählte Dauer auf der Master-Timeline (Sekunden). */
  durationS: number;
  // ---- Editor-state, persisted via auto-save ----
  startOffsetS?: number;
  /** User-applied rotation (degrees, V1: 0/90/180/270). Default 0. */
  rotation?: number;
  /** Mirror the image horizontally / vertically. Defaults false. */
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element Stage placement (cover-fit + scale + translate). */
  viewportTransform?: {
    scale: number;
    x: number;
    y: number;
  };
}

export type MediaAsset = VideoAsset | ImageAsset;

/** True iff the asset is an image clip (kind === "image"). VideoAssets
 *  may have kind undefined (legacy rows) or "video"; both count as video. */
export function isImageAsset(a: MediaAsset): a is ImageAsset {
  return a.kind === "image";
}
export function isVideoAsset(a: MediaAsset): a is VideoAsset {
  return a.kind !== "image";
}

/**
 * Multi-Cam-Cut: ab `atTimeS` wird auf `camId` umgeschaltet.
 *
 * Cuts sind nach `atTimeS` aufsteigend geordnet. Active-Cam an einem
 * Zeitpunkt = letzter Cut mit `atTimeS ≤ t` (siehe `editor/cuts.ts`).
 */
export interface Cut {
  atTimeS: number;
  camId: string;
}

export interface JobProgress {
  pct: number;
  stage: string;
  detail?: string;
  etaS?: number;
  framesDone?: number;
  framesTotal?: number;
}

export type JobStatus =
  | "queued"
  | "syncing"
  | "synced"
  | "rendering"
  | "rendered"
  | "failed";

export interface LocalJob {
  id: string;
  title: string | null;

  /** V1-Feld: Pfad des (ersten) Videos. Bleibt für Legacy-Consumer erhalten;
   * der kanonische Pfad ist ab V2 `videos[i].filename`. */
  videoFilename: string;
  audioFilename: string;

  status: JobStatus;
  progress: JobProgress;
  error?: string;

  /** V1-Feld: Sync-Result für das (eine) Video. Ab V2 lebt das pro Video in
   * `videos[i].sync`. Wird zur Backward-Compat hier gespiegelt. */
  sync?: SyncResult;

  durationS?: number;
  width?: number;
  height?: number;
  fps?: number;

  /** Set when a timeline thumbnail strip has been generated for this job
   *  (file at `jobs/{id}/frames.webp`). Layout details are reproducible from
   *  the source duration + dimensions, so we don't persist the full manifest. */
  hasFrames?: boolean;

  /** EditSpec (typisiert in einem späteren Modul). Bewusst unknown hier, um
   * Coupling zu vermeiden. */
  editSpec?: unknown;

  hasOutput: boolean;
  outputBytes?: number;

  createdAt: number;
  startedAt?: number;
  finishedAt?: number;

  // ---- V2 (Multi-Video) ----

  /** Persistierte Schema-Version. Fehlt bei Jobs, die vor der V2-Migration
   * geschrieben wurden. */
  schemaVersion?: 2;

  /** Multi-Cam-Quellen. Bei V1-Jobs nach Migration genau ein Element.
   *  Heißt historisch "videos" — enthält ab dem Image-Clip-Schema eine
   *  Mischung aus VideoAsset und ImageAsset. Discriminator ist `kind`
   *  (undefined / "video" → VideoAsset). */
  videos?: MediaAsset[];

  /** Multi-Cam-Cuts auf der Master-Timeline. Leer bei Single-Cam-Jobs. */
  cuts?: Cut[];

  // ---- Editor-state, persisted via auto-save ----
  /** Detected master-audio tempo + user override. Set after the audio-
   *  analysis pre-step finishes. */
  bpm?: {
    value: number;
    confidence: number;
    phase: number;
    manualOverride?: boolean;
  };
  /** User correction to the auto-detected audio start (signed seconds).
   *  Lives at the LocalJob level — not in the analysis cache — so
   *  re-running analysis (which rewrites bpm + audioStartS) doesn't
   *  clobber the user's correction. Default 0 / undefined. */
  audioStartNudgeS?: number;
  /** Time-signature numerator (= beats per bar). The denominator is not
   *  persisted — only the count matters for grid + snap math. Default 4. */
  beatsPerBar?: number;
  /** Anacrusis / pickup, in beats. Stored modulo `beatsPerBar`. Default 0. */
  barOffsetBeats?: number;
  /** Persistent UI bits the user expects to find on next open. */
  ui?: {
    snapMode?: "off" | "match" | "1" | "1/2" | "1/4" | "1/8" | "1/16";
    lanesLocked?: boolean;
  };
  /** Trim region (seconds). Mirrors editSpec.segments[0] but persisted on
   *  every drag, not only at render time. */
  trim?: { in: number; out: number };

  /** Punch-in FX (P-FX) — visual effects with in/out spans, freely
   *  overlapping. Optional; absent on legacy jobs that pre-date the
   *  feature. The renderer reads this verbatim. */
  fx?: PunchFxRecord[];

  /** Master-audio playback gain (linear). 1.0 = source level (default),
   *  0 = muted, 2.0 = +6 dB. Applied at preview time and baked into the
   *  rendered output. Optional / undefined → default 1.0. */
  audioVolume?: number;

  /** Persisted Export-Panel selections (Aspect, Resolution, codecs, …).
   *  Round-trips through the editor so the user's Stage shape + bitrate
   *  choices survive a reload. Stored as `unknown` to avoid coupling the
   *  storage layer to the editor's `ExportSpec` type — the editor
   *  validates / ignores fields it doesn't recognise. */
  exportSpec?: unknown;
}

/** Storage shape for a single Punch-in FX. Mirrors `PunchFx` from the
 *  editor module — kept duplicated here to avoid cross-module type
 *  dependency at the storage layer. New kinds added to `FxKind` need
 *  to be mirrored here so persisted jobs round-trip cleanly. */
export type PunchFxKindRecord =
  | "vignette"
  | "wear"
  | "echo"
  | "rgb"
  | "tape"
  | "zoom"
  | "uv";

export interface PunchFxRecord {
  id: string;
  kind: PunchFxKindRecord;
  inS: number;
  outS: number;
  params?: Record<string, number>;
  /** ADSR-Hüllkurve. Optional — fehlt bei Pre-V1-Records, dann rendern
   *  die FX wie bisher (hard-edge an inS/outS, kein Crossfade). */
  envelope?: {
    attackS: number;
    decayS: number;
    sustain: number;
    releaseS: number;
  };
}

const DB_NAME = "videoaudiosync";
const DB_VERSION = 3;
const STORE = "jobs";
const ANALYSIS_STORE = "audio-analysis";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(database, oldVersion, _newVersion, tx) {
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("by-createdAt", "createdAt");
        }

        // V1 → V2: jeden Job in-place auf das Multi-Video-Schema heben.
        // Läuft in der vom upgrade-Callback gelieferten Transaktion, also
        // atomar mit dem schema-bump.
        if (oldVersion > 0 && oldVersion < 2) {
          const store = tx.objectStore(STORE);
          let cursor = await store.openCursor();
          while (cursor) {
            const migrated = migrateV1ToV2(cursor.value as LocalJob);
            await cursor.update(migrated);
            cursor = await cursor.continue();
          }
        }

        // V2 → V3: separater Object-Store für Audio-Analyse. Keine
        // Datenmigration nötig — bestehende Jobs triggern beim nächsten
        // Editor-Open eine frische Analyse.
        if (oldVersion < 3 && !database.objectStoreNames.contains(ANALYSIS_STORE)) {
          database.createObjectStore(ANALYSIS_STORE, { keyPath: "jobId" });
        }
      },
    });
  }
  return dbPromise;
}

async function saveJob(job: LocalJob): Promise<void> {
  const d = await db();
  await d.put(STORE, job);
}

async function getJob(id: string): Promise<LocalJob | undefined> {
  const d = await db();
  return (await d.get(STORE, id)) as LocalJob | undefined;
}

async function listJobs(): Promise<LocalJob[]> {
  const d = await db();
  const all = (await d.getAll(STORE)) as LocalJob[];
  // Sortierung newest-first für die History-Page.
  all.sort((a, b) => b.createdAt - a.createdAt);
  return all;
}

async function updateJob(id: string, patch: Partial<LocalJob>): Promise<LocalJob> {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  const existing = (await tx.store.get(id)) as LocalJob | undefined;
  if (!existing) {
    await tx.done;
    throw new Error(`Job not found: ${id}`);
  }
  const merged: LocalJob = { ...existing, ...patch, id: existing.id };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

async function deleteJob(id: string): Promise<void> {
  const d = await db();
  await d.delete(STORE, id);
  if (d.objectStoreNames.contains(ANALYSIS_STORE)) {
    await d.delete(ANALYSIS_STORE, id);
  }
}

async function wipeAll(): Promise<void> {
  const d = await db();
  await d.clear(STORE);
  if (d.objectStoreNames.contains(ANALYSIS_STORE)) {
    await d.clear(ANALYSIS_STORE);
  }
}

interface AnalysisRecord<T> {
  jobId: string;
  payload: T;
}

async function getAudioAnalysis<T>(jobId: string): Promise<T | undefined> {
  const d = await db();
  const rec = (await d.get(ANALYSIS_STORE, jobId)) as
    | AnalysisRecord<T>
    | undefined;
  return rec?.payload;
}

async function saveAudioAnalysis<T>(jobId: string, payload: T): Promise<void> {
  const d = await db();
  const rec: AnalysisRecord<T> = { jobId, payload };
  await d.put(ANALYSIS_STORE, rec);
}

async function deleteAudioAnalysis(jobId: string): Promise<void> {
  const d = await db();
  if (d.objectStoreNames.contains(ANALYSIS_STORE)) {
    await d.delete(ANALYSIS_STORE, jobId);
  }
}

export const jobsDb = {
  saveJob,
  getJob,
  listJobs,
  updateJob,
  deleteJob,
  wipeAll,
  getAudioAnalysis,
  saveAudioAnalysis,
  deleteAudioAnalysis,
};

export type JobsDb = typeof jobsDb;
