/**
 * IndexedDB-Wrapper für lokale Job-Metadaten.
 *
 * Mediadaten (Video, Audio, Render-Output) leben in OPFS (siehe ./opfs.ts).
 * Hier liegen nur strukturierte Daten: Status, Sync-Result, Edit-Spec,
 * Progress, Timing.
 */

import { openDB, type IDBPDatabase } from "idb";
import { migrateV1ToV2 } from "./migrations";
import type { AssetSource } from "../local/asset-source";

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
  /** OPFS-Pfad der Mediadatei. Required for legacy (v2) rows; on v3+
   *  rows that hold a `FileSystemFileHandle` source it stays set as a
   *  stable identifier (used for derived paths like `framesPath`) but
   *  the bytes live on the user's disk, not in OPFS. Read sites should
   *  prefer `loadAssetFile(asset)` over reading `opfsPath` directly. */
  opfsPath: string;
  /** v3+: explicit asset source. When present, takes precedence over
   *  `opfsPath` for byte access. Holds either an OPFS path or a native
   *  `FileSystemFileHandle` (persisted via IDB structured clone). */
  source?: AssetSource;
  /** Cam-Farbe für PROGRAM-Strip + Lane-Header (deterministisch beim Upload). */
  color: string;
  sync?: SyncResult;
  durationS?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Display rotation in degrees clockwise that needs to be applied to
   *  the codec-level pixel buffer for correct on-screen orientation.
   *  Decoded from the source MP4's `tkhd` matrix at sync time and
   *  persisted so consumers (chunk-thumbnail extractor, future
   *  renderers) don't have to re-demux just for the rotation flag.
   *  Optional / undefined for legacy rows synced before this field
   *  existed — those callers can fall back to a `<video>.videoWidth /
   *  videoHeight` vs `width / height` swap-heuristic. */
  intrinsicRotationDeg?: 0 | 90 | 180 | 270;
  /** OPFS-Pfad zur extrahierten Thumbnail-Strip-Datei (frames.webp). */
  framesPath?: string;
  /** What pixel orientation the strip at `framesPath` carries.
   *
   *  - `"display"` — strip tiles are already display-oriented (rotation
   *    baked in at extraction time). Tier-2 thumbnail consumers can
   *    blit them straight to canvas. NEW.
   *  - `"codec"` (or undefined for legacy rows) — strip tiles store
   *    raw codec frames (no rotation). Consumers must apply
   *    `intrinsicRotationDeg` themselves at slice time.
   *
   *  This is per-cam because we may incrementally re-extract one cam's
   *  strip without forcing a re-extract of the others. */
  framesOrientation?: "codec" | "display";
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
  /** v3+: explicit asset source. Mirrors VideoAsset.source — see there. */
  source?: AssetSource;
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
 * Display-oriented dimensions for a cam — codec dims swapped when the
 * intrinsic rotation is 90/270 (portrait phone recordings).
 *
 * Use this for any consumer that operates on the actual on-screen
 * frame: `<video>.videoWidth/Height` matches these values, the
 * baked-in (framesOrientation: "display") strip's tile aspect matches
 * these, and the edit compositor's output canvas should follow them.
 *
 * Returns null when the cam never had width/height probed (legacy
 * rows synced before width/height were captured).
 */
export function displayDimsOf(
  cam: VideoAsset,
): { width: number; height: number } | null {
  if (cam.width === undefined || cam.height === undefined) return null;
  const swap = cam.intrinsicRotationDeg === 90 || cam.intrinsicRotationDeg === 270;
  return swap
    ? { width: cam.height, height: cam.width }
    : { width: cam.width, height: cam.height };
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

/**
 * Workflow-Pfad nach dem Upload.
 *  - "direct"   — fertiges Stück + Video(s) → direkt in den Editor.
 *  - "longform" — Session-Mitschnitt → Triage → Arrange → Editor.
 *
 * Optional auf `LocalJob`; fehlende Werte werden als `"direct"` behandelt
 * (rückwärtskompatibel mit allen Pre-Triage-Jobs).
 */
export type JobMode = "direct" | "longform";

/** Stille-Detector-Parameter. Live anpassbar in der Triage-UI. */
export interface SilenceConfig {
  /** Threshold in dBFS (negativ; z.B. -50). Audio ≤ dieser Lautstärke
   *  zählt als Stille. */
  thresholdDb: number;
  /** Mindestpausenlänge (ms) — kürzere Pausen werden ignoriert (vermeidet
   *  Mikro-Splits zwischen Drum-Hits). */
  minPauseMs: number;
}

/**
 * Ein erkanntes Audio-Stück im Long-Form-Master. Wird in der Triage-Phase
 * vom Detection-Worker erzeugt und kann pro Chunk vom User akzeptiert,
 * verworfen, getrimmt oder im BPM angepasst werden.
 *
 * Stable IDs überleben eine erneute Detection (re-running threshold/min-
 * pause behält bestehende Chunk-IDs für noch existierende Bereiche bei).
 */
export interface Chunk {
  id: string;
  /** Master-Audio-Zeit in ms. */
  startMs: number;
  endMs: number;
  /** Vom Detection-Worker pro Chunk erkanntes BPM, falls verfügbar.
   *  Long-form-Sessions bestehen aus unabhängigen musikalischen
   *  Fragmenten — daher detect pro Chunk und aggregiere zum
   *  Song-globalen `job.bpm` (Mode der per-Chunk-Werte). */
  detectedBpm?: number;
  /** User-Override für Half/Double-Time. -1 → ÷2, 0 → unverändert,
   *  1 → ×2. Wird auf `detectedBpm` angewendet, ergibt `effectiveBpm`. */
  bpmOctaveShift: -1 | 0 | 1;
  /** Tatsächlich für Bar-Berechnung verwendetes BPM. Default = detectedBpm
   *  * 2^bpmOctaveShift; default = job.bpm wenn der User keinen
   *  per-Chunk-Override gesetzt hat. */
  effectiveBpm: number;
  /** Bar-grid phase anchor (master-audio time, ms). Marks a single point
   *  the chunk's bar grid is anchored on; the rendered grid is then
   *  `audioStartMs + N * msPerBar`. Misnamed for legacy reasons — does
   *  NOT necessarily mark where audio starts. The detector seeds it from
   *  the first onset; `splitChunkAt` projects it onto the new range as
   *  a bar boundary of the original grid; `conformChunk` re-fits it
   *  from the chunk's current audio range. Chunks are not aligned to
   *  each other — each carries its own anchor. Default = startMs when
   *  no onset was detected. */
  audioStartMs?: number;
  /** Snapshot of (startMs, endMs, audioStartMs) taken just before the
   *  most recent `conformChunk` call — undefined when the chunk has
   *  never been conformed (or has been reverted/edited since). Powers
   *  the "Original" button next to Conform: revert to this state and
   *  clear the snapshot. Cleared on split/join/extend/reset to avoid
   *  surfacing a stale undo target. */
  preConformSnapshot?: {
    startMs: number;
    endMs: number;
    audioStartMs?: number;
  };
  /** Berechnete Bar-Anzahl (Dauer / Sekunden-pro-Bar). Optional — UI
   *  kann das auf der Fly berechnen falls nicht persistiert. */
  bars?: number;
  /** Time-Signature-Numerator (default 4). */
  beatsPerBar: number;
  /** Im Arrangement enthalten? Cherry-Pick passiert in Triage. */
  accepted: boolean;
  /** Snap-Modus für In/Out-Drag. */
  trimMode: "auto" | "bar" | "free";
  /** Optional: User-getrimmte Boundaries, falls abweichend von der
   *  ursprünglichen Detection. */
  trimStartMs?: number;
  trimEndMs?: number;
  /** Snapshot der Detection-Boundaries (oder bei manuellen Chunks
   *  ihrer initialen Werte). Treibt den "Reset"-Button im Inspector,
   *  der den Chunk wieder auf seinen Ausgangszustand zurücksetzen
   *  darf. Optional: legacy-Chunks ohne dieses Feld können nicht
   *  zurückgesetzt werden — Reset-Button ist dann disabled. */
  originalStartMs?: number;
  originalEndMs?: number;
  originalAudioStartMs?: number;
}

/**
 * Eintrag in der Arrange-Phase: referenziert einen Chunk (per ID) und
 * gibt ihm seinen Platz in der finalen Reihenfolge. Ein Chunk kann
 * mehrfach im Arrangement vorkommen (Duplicate-Funktion); jede Instanz
 * hat ihre eigene `ArrangementItem.id` für Stable-Editor-Edits.
 */
export interface ArrangementItem {
  id: string;
  chunkId: string;
}

export interface LocalJob {
  id: string;
  title: string | null;

  /** V1-Feld: Pfad des (ersten) Videos. Bleibt für Legacy-Consumer erhalten;
   * der kanonische Pfad ist ab V2 `videos[i].filename`. */
  videoFilename: string;
  audioFilename: string;
  /** v3+: explicit asset source for the master audio. When present,
   *  takes precedence over deriving the OPFS path from `audioFilename`.
   *  Either an OPFS path or a `FileSystemFileHandle` to the user's
   *  original audio file. */
  audioSource?: AssetSource;

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
   * geschrieben wurden. v3 added `source` / `audioSource` for native
   * `FileSystemFileHandle`-backed assets — old rows continue to work
   * via the `opfsPath` fallback inside `loadAssetFile`. */
  schemaVersion?: 2 | 3;

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

  // ---- Long-Form Triage Workflow ----

  /** Workflow-Pfad. Fehlt bei Pre-Triage-Jobs → wird als `"direct"`
   *  behandelt. Beim Upload gesetzt; ändert sich danach nicht mehr. */
  mode?: JobMode;

  /** Letzte vom User justierten Detection-Parameter. Werden in der
   *  Triage-UI live mutiert; persistiert damit ein Reload an derselben
   *  Stelle weitermacht. Nur sinnvoll für `mode === "longform"`. */
  silenceConfig?: SilenceConfig;

  /** Session-weite BPM-Erzwingung. Wenn gesetzt, gilt dieser Wert für
   *  alle Chunks ohne eigenen Octave-Shift. */
  sessionBpmOverride?: number;

  /** Erkannte (und vom User kuratierte) Audio-Chunks. Nur für
   *  Long-Form-Jobs; bei Direct bleibt das undefined. */
  chunks?: Chunk[];

  /** Geordnete Sequenz von Chunks (mit möglichen Duplikaten) für die
   *  Editor-Pre-Population. Wird in der Arrange-Phase gefüllt. */
  arrangement?: ArrangementItem[];

  /** Editor-side pill list — first-class slots of cam material on the
   *  song timeline. Auto-generated from `arrangement × cams × chunks`
   *  on first editor mount; persisted here so user edits (move / trim)
   *  survive across mounts / refreshes. Pills with ids whose underlying
   *  arrangement-item disappears are reconciled out at load time. */
  pills?: PillRecord[];

  /** Cached RMS-envelope of the master audio at 10 Hz, computed during
   *  sync. Lets Triage render the waveform overview without
   *  re-decoding the multi-GB PCM up front. ~144 KB per hour of
   *  audio — comfortable in IDB. Float32Array round-trips through
   *  structured-clone natively. Optional / undefined for jobs synced
   *  before this field existed (or direct-mode jobs). */
  triageEnvelope?: Float32Array;
}

/** Persisted shape of `Pill` (from editor/types). Mirrored here to keep
 *  the storage layer free of editor-module imports. Same field semantics
 *  as the runtime type. */
export interface PillRecord {
  id: string;
  camId: string;
  arrStartS: number;
  arrEndS: number;
  sourceInS: number;
  sourceOutS: number;
  originalArrStartS: number;
  originalArrEndS: number;
  originalSourceInS: number;
  originalSourceOutS: number;
  fromArrangementItemId?: string;
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
const DB_VERSION = 7;
const STORE = "jobs";
const ANALYSIS_STORE = "audio-analysis";
/** Per-chunk thumbnail JPEG bytes, keyed by `${jobId}::${camId}::${chunkId}`.
 *  Filled lazily by the Arrange page so reloads don't re-decode the
 *  underlying video. Bounded soft-cap: callers can prune via
 *  `pruneChunkThumbnailsForJob` when a job is deleted. */
const CHUNK_THUMBS_STORE = "chunk-thumbnails";
/** Per-chunk mel-spectrogram bytes (u8 grayscale), keyed by
 *  `${jobId}::${chunkId}`. Computed once when the user first opens
 *  Arrange for a job and cached so re-mounts don't re-decode the
 *  master audio. */
const CHUNK_MELS_STORE = "chunk-mel-specs";

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

        // V3 → V4: chunk-thumbnail cache so the Arrange page doesn't
        // re-decode the same per-chunk thumbnails on every reload.
        if (oldVersion < 4 && !database.objectStoreNames.contains(CHUNK_THUMBS_STORE)) {
          const s = database.createObjectStore(CHUNK_THUMBS_STORE, {
            keyPath: "key",
          });
          s.createIndex("by-jobId", "jobId");
        }

        // V4 → V5: chunk-thumbnail extraction logic learned to apply
        // intrinsic MP4 rotation. Old cached blobs were extracted
        // without the rotation transform — wipe them so the next
        // page-mount re-extracts via the corrected pipeline.
        // Auto-heal — no user-facing migration UI needed.
        if (oldVersion === 4 && database.objectStoreNames.contains(CHUNK_THUMBS_STORE)) {
          const s = tx.objectStore(CHUNK_THUMBS_STORE);
          await s.clear();
        }

        // V5 → V6: per-chunk mel-spectrogram cache for the Arrange-page
        // glance display. No data migration — fresh store, lazily
        // filled on first Arrange mount per job.
        if (oldVersion < 6 && !database.objectStoreNames.contains(CHUNK_MELS_STORE)) {
          const s = database.createObjectStore(CHUNK_MELS_STORE, {
            keyPath: "key",
          });
          s.createIndex("by-jobId", "jobId");
        }

        // V6 → V7: chunk-thumbnail extraction switched from "200 px wide
        // upscaled JPEG" to "native tile resolution + tier-3 fallback
        // for tiles too small to upscale". Old cached thumbs are blocky
        // (especially for portrait clips) — wipe them so the next page
        // mount re-extracts via the corrected pipeline.
        if (oldVersion === 6 && database.objectStoreNames.contains(CHUNK_THUMBS_STORE)) {
          const s = tx.objectStore(CHUNK_THUMBS_STORE);
          await s.clear();
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
  await deleteChunkThumbnailsForJob(id);
  await deleteChunkMelSpecsForJob(id);
}

async function wipeAll(): Promise<void> {
  const d = await db();
  await d.clear(STORE);
  if (d.objectStoreNames.contains(ANALYSIS_STORE)) {
    await d.clear(ANALYSIS_STORE);
  }
  if (d.objectStoreNames.contains(CHUNK_THUMBS_STORE)) {
    await d.clear(CHUNK_THUMBS_STORE);
  }
  if (d.objectStoreNames.contains(CHUNK_MELS_STORE)) {
    await d.clear(CHUNK_MELS_STORE);
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

interface ChunkThumbnailRecord {
  /** `${jobId}::${camId}::${chunkId}` — primary key. */
  key: string;
  jobId: string;
  /** image/jpeg bytes. */
  blob: Blob;
}

function chunkThumbKey(jobId: string, camId: string, chunkId: string): string {
  return `${jobId}::${camId}::${chunkId}`;
}

async function getChunkThumbnail(
  jobId: string,
  camId: string,
  chunkId: string,
): Promise<Blob | undefined> {
  const d = await db();
  if (!d.objectStoreNames.contains(CHUNK_THUMBS_STORE)) return undefined;
  const rec = (await d.get(
    CHUNK_THUMBS_STORE,
    chunkThumbKey(jobId, camId, chunkId),
  )) as ChunkThumbnailRecord | undefined;
  return rec?.blob;
}

async function saveChunkThumbnail(
  jobId: string,
  camId: string,
  chunkId: string,
  blob: Blob,
): Promise<void> {
  const d = await db();
  if (!d.objectStoreNames.contains(CHUNK_THUMBS_STORE)) return;
  const rec: ChunkThumbnailRecord = {
    key: chunkThumbKey(jobId, camId, chunkId),
    jobId,
    blob,
  };
  await d.put(CHUNK_THUMBS_STORE, rec);
}

/** Drop every cached thumbnail for a job (e.g. when the job itself is
 *  deleted). Iterates the by-jobId index. */
async function deleteChunkThumbnailsForJob(jobId: string): Promise<void> {
  const d = await db();
  if (!d.objectStoreNames.contains(CHUNK_THUMBS_STORE)) return;
  const tx = d.transaction(CHUNK_THUMBS_STORE, "readwrite");
  const idx = tx.store.index("by-jobId");
  let cursor = await idx.openCursor(IDBKeyRange.only(jobId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

interface ChunkMelRecord {
  /** `${jobId}::${chunkId}` */
  key: string;
  jobId: string;
  /** Frame-major u8 mel-spec data, length = `nMels * nFrames`. */
  data: Uint8Array;
  nMels: number;
  nFrames: number;
  /** Original chunk duration in seconds — lets the renderer pick a
   *  pixel width independent of the mel frame count. */
  durationS: number;
  /** 12-bin chroma profile. Optional for back-compat with v6 records
   *  that were saved before key-detection landed. Class 0 = C. */
  chroma?: Float32Array;
}

function chunkMelKey(jobId: string, chunkId: string): string {
  return `${jobId}::${chunkId}`;
}

async function getChunkMelSpec(
  jobId: string,
  chunkId: string,
): Promise<ChunkMelRecord | undefined> {
  const d = await db();
  if (!d.objectStoreNames.contains(CHUNK_MELS_STORE)) return undefined;
  return (await d.get(CHUNK_MELS_STORE, chunkMelKey(jobId, chunkId))) as
    | ChunkMelRecord
    | undefined;
}

async function saveChunkMelSpec(
  jobId: string,
  chunkId: string,
  data: Uint8Array,
  nMels: number,
  nFrames: number,
  durationS: number,
  chroma?: Float32Array,
): Promise<void> {
  const d = await db();
  if (!d.objectStoreNames.contains(CHUNK_MELS_STORE)) return;
  const rec: ChunkMelRecord = {
    key: chunkMelKey(jobId, chunkId),
    jobId,
    data,
    nMels,
    nFrames,
    durationS,
    chroma,
  };
  await d.put(CHUNK_MELS_STORE, rec);
}

async function deleteChunkMelSpecsForJob(jobId: string): Promise<void> {
  const d = await db();
  if (!d.objectStoreNames.contains(CHUNK_MELS_STORE)) return;
  const tx = d.transaction(CHUNK_MELS_STORE, "readwrite");
  const idx = tx.store.index("by-jobId");
  let cursor = await idx.openCursor(IDBKeyRange.only(jobId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export type { ChunkMelRecord };

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
  getChunkThumbnail,
  saveChunkThumbnail,
  deleteChunkThumbnailsForJob,
  getChunkMelSpec,
  saveChunkMelSpec,
  deleteChunkMelSpecsForJob,
};

export type JobsDb = typeof jobsDb;
