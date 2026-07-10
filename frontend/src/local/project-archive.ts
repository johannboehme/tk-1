/**
 * Project backup / portability (#86).
 *
 * All edit state lives in one browser profile's IndexedDB row and the
 * media in OPFS (or behind native file handles) — a 'Clear site data',
 * storage eviction, or wanting to continue on another machine used to
 * mean losing everything except the rendered MP4. This module packages
 * a project into a single self-contained `.tk1.zip`:
 *
 *   project.json     — versioned manifest + the full LocalJob row
 *                      (Float32Array fields base64-tagged; native file
 *                      handles replaced by OPFS sources, since the bytes
 *                      travel inside the archive)
 *   media/*          — master audio, every cam's video/image bytes,
 *                      generated frame strips, and the rendered output
 *
 * Import reverses it: media goes back into OPFS (all assets become
 * OPFS-backed, even ones that were handle-backed at export), the row is
 * re-inserted — under a fresh id (with all internal paths rewritten)
 * when the archived id is already taken in this browser.
 *
 * Recomputable caches (audio analysis, waveform pyramid, chunk thumbs /
 * mel specs) are deliberately NOT archived — they rebuild lazily.
 */

import {
  isVideoAsset,
  jobsDb,
  type LocalJob,
  type MediaAsset,
} from "../storage/jobs-db";
import { opfs } from "../storage/opfs";
import {
  buildZip,
  readZipIndex,
  zipEntryBlob,
  type ZipEntrySpec,
} from "../storage/zip";
import {
  AssetPermissionError,
  loadAsset,
  requestReadPermission,
  type AssetSource,
} from "./asset-source";
import { emitJobUpdate } from "./jobs-events";
import { downloadFilename } from "../lib/filenames";

export const ARCHIVE_FORMAT = "tk1-project";
export const ARCHIVE_VERSION = 1;

export interface ArchiveMediaEntry {
  /** Path inside the zip (under media/). */
  zipPath: string;
  /** OPFS path the bytes belong at, relative to the ARCHIVED job id.
   *  Import rewrites the `jobs/{id}/` prefix when it mints a new id. */
  opfsPath: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: number;
  job: Record<string, unknown>;
  media: ArchiveMediaEntry[];
}

// ---------------------------------------------------------------------------
// Job row (de)serialisation
// ---------------------------------------------------------------------------

interface TaggedF32 {
  __tk1Type: "f32";
  data: string; // base64 of the little-endian bytes
}

function b64FromBytes(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function encodeValue(v: unknown): unknown {
  if (v instanceof Float32Array) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { __tk1Type: "f32", data: b64FromBytes(bytes) } satisfies TaggedF32;
  }
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined || typeof val === "function") continue;
      out[k] = encodeValue(val);
    }
    return out;
  }
  return v;
}

function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (rec.__tk1Type === "f32" && typeof rec.data === "string") {
      const bytes = bytesFromB64(rec.data);
      return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = decodeValue(val);
    return out;
  }
  return v;
}

function fileExtensionOf(name: string, fallback: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return fallback;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/i.test(ext) ? ext : fallback;
}

/** The canonical OPFS path of a job's master audio — mirrors the
 *  convention in local/jobs.ts (`jobs/{id}/audio.{ext}`). */
export function audioOpfsPathOf(job: LocalJob): string {
  if (job.audioSource?.kind === "opfs") return job.audioSource.path;
  const ext = fileExtensionOf(job.audioFilename, "wav");
  return `jobs/${job.id}/audio.${ext}`;
}

function outputOpfsPathOf(jobId: string): string {
  return `jobs/${jobId}/output.mp4`;
}

/**
 * Replace native FileSystemFileHandle sources with OPFS sources: the
 * bytes travel inside the archive, and import restores them into OPFS.
 * Handles don't survive serialisation (and wouldn't work on another
 * machine anyway). Pure — exported for tests.
 */
export function stripHandlesForArchive(job: LocalJob): LocalJob {
  const videos = job.videos?.map((v): MediaAsset => {
    if (v.source?.kind === "handle") {
      return { ...v, source: { kind: "opfs", path: v.opfsPath } };
    }
    return v;
  });
  const audioSource: AssetSource = {
    kind: "opfs",
    path: audioOpfsPathOf(job),
  };
  return { ...job, videos, audioSource };
}

/**
 * Rewrite every `jobs/{oldId}/…` path (asset opfsPath / source.path /
 * framesPath / audioSource.path) and the row id itself onto a new job
 * id. Used when importing into a browser where the archived id is
 * already taken. Pure — exported for tests.
 */
export function rewriteJobPaths(job: LocalJob, newId: string): LocalJob {
  const oldPrefix = `jobs/${job.id}/`;
  const newPrefix = `jobs/${newId}/`;
  const fix = (p: string): string =>
    p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p;
  const fixSource = (s: AssetSource | undefined): AssetSource | undefined =>
    s?.kind === "opfs" ? { kind: "opfs", path: fix(s.path) } : s;

  const videos = job.videos?.map((v): MediaAsset => {
    const next = { ...v, opfsPath: fix(v.opfsPath), source: fixSource(v.source) };
    if (isVideoAsset(v) && v.framesPath) {
      (next as typeof v).framesPath = fix(v.framesPath);
    }
    return next;
  });

  return {
    ...job,
    id: newId,
    videos,
    audioSource: fixSource(job.audioSource),
  };
}

/** Validate + parse a project.json payload. Throws with a clear message
 *  on foreign files and archives from a newer app version. */
export function parseArchiveManifest(json: string): ArchiveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Not a TK-1 project archive (project.json is not valid JSON)");
  }
  const m = raw as Partial<ArchiveManifest>;
  if (m?.format !== ARCHIVE_FORMAT) {
    throw new Error("Not a TK-1 project archive");
  }
  if (typeof m.version !== "number" || m.version > ARCHIVE_VERSION) {
    throw new Error(
      "This archive was exported by a newer version of TK-1 — update the app and retry",
    );
  }
  if (!m.job || typeof m.job !== "object" || !Array.isArray(m.media)) {
    throw new Error("Corrupt TK-1 project archive (manifest incomplete)");
  }
  return m as ArchiveManifest;
}

function decodeJobFromArchive(encoded: Record<string, unknown>): LocalJob {
  const job = decodeValue(encoded) as LocalJob;
  if (typeof job.id !== "string" || !job.id) {
    throw new Error("Corrupt TK-1 project archive (job row has no id)");
  }
  if (typeof job.audioFilename !== "string") {
    throw new Error("Corrupt TK-1 project archive (job row incomplete)");
  }
  return job;
}

function freshJobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function loadAssetForArchive(
  source: AssetSource,
  displayName: string,
): Promise<Blob> {
  try {
    return await loadAsset(source);
  } catch (err) {
    // Handle-backed asset without an active grant: the export click is a
    // user gesture, so one re-prompt is allowed.
    if (err instanceof AssetPermissionError && source.kind === "handle") {
      const state = await requestReadPermission(source);
      if (state === "granted") return await loadAsset(source);
    }
    throw new Error(
      `Could not read "${displayName}" for the archive. ` +
        `Open the project once to re-grant file access, then retry the export.`,
    );
  }
}

export interface ExportedArchive {
  blob: Blob;
  filename: string;
}

/** Package a project into a self-contained `.tk1.zip` Blob. */
export async function exportProjectArchive(
  jobId: string,
): Promise<ExportedArchive> {
  const job = await jobsDb.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const media: ArchiveMediaEntry[] = [];
  const zipEntries: ZipEntrySpec[] = [];
  const usedNames = new Set<string>(["project.json"]);

  const addMedia = (opfsPath: string, data: Blob) => {
    const base = opfsPath.split("/").pop() ?? "file";
    let zipPath = `media/${base}`;
    for (let n = 2; usedNames.has(zipPath); n++) {
      zipPath = `media/${n}-${base}`;
    }
    usedNames.add(zipPath);
    media.push({ zipPath, opfsPath });
    zipEntries.push({ name: zipPath, data });
  };

  // Master audio — handle-backed, OPFS-backed, or legacy path-derived.
  const audioSource: AssetSource =
    job.audioSource ?? { kind: "opfs", path: audioOpfsPathOf(job) };
  addMedia(
    audioOpfsPathOf(job),
    await loadAssetForArchive(audioSource, job.audioFilename),
  );

  // Cams (videos + images) and their derived frame strips.
  for (const asset of job.videos ?? []) {
    const source: AssetSource =
      asset.source ?? { kind: "opfs", path: asset.opfsPath };
    addMedia(
      asset.opfsPath,
      await loadAssetForArchive(source, asset.filename),
    );
    if (
      isVideoAsset(asset) &&
      asset.framesPath &&
      (await opfs.exists(asset.framesPath))
    ) {
      addMedia(asset.framesPath, await opfs.readFile(asset.framesPath));
    }
  }

  // Rendered output, when it exists.
  const outputPath = outputOpfsPathOf(job.id);
  if (job.lastRender && (await opfs.exists(outputPath))) {
    addMedia(outputPath, await opfs.readFile(outputPath));
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: Date.now(),
    job: encodeValue(stripHandlesForArchive(job)) as Record<string, unknown>,
    media,
  };

  const blob = await buildZip([
    {
      name: "project.json",
      data: new Blob([JSON.stringify(manifest, null, 2)], {
        type: "application/json",
      }),
    },
    ...zipEntries,
  ]);
  return {
    blob,
    filename: downloadFilename(job.title || job.id, "tk1.zip"),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function textOf(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Blob read failed"));
    r.readAsText(blob);
  });
}

export interface ImportedProject {
  jobId: string;
  title: string | null;
}

/**
 * Restore a project from a `.tk1.zip` archive. All assets come back
 * OPFS-backed. When the archived job id already exists in this browser,
 * a fresh id is minted and every internal path rewritten — importing
 * the same archive twice yields two independent projects.
 */
export async function importProjectArchive(
  file: Blob,
): Promise<ImportedProject> {
  const index = await readZipIndex(file);
  const manifestEntry = index.find((e) => e.name === "project.json");
  if (!manifestEntry) {
    throw new Error("Not a TK-1 project archive (project.json missing)");
  }
  const manifest = parseArchiveManifest(
    await textOf(await zipEntryBlob(file, manifestEntry)),
  );
  const archivedJob = decodeJobFromArchive(manifest.job);
  const archivedId = archivedJob.id;

  const collision = await jobsDb.getJob(archivedId);
  const job = collision
    ? rewriteJobPaths(archivedJob, freshJobId())
    : archivedJob;

  const rewritePath = (p: string): string =>
    p.startsWith(`jobs/${archivedId}/`)
      ? `jobs/${job.id}/` + p.slice(`jobs/${archivedId}/`.length)
      : p;

  const byName = new Map(index.map((e) => [e.name, e] as const));
  try {
    for (const m of manifest.media) {
      const entry = byName.get(m.zipPath);
      if (!entry) {
        throw new Error(`Corrupt TK-1 project archive (missing ${m.zipPath})`);
      }
      await opfs.writeFile(
        rewritePath(m.opfsPath),
        await zipEntryBlob(file, entry),
      );
    }
  } catch (err) {
    // Never leave orphaned bytes behind (#119).
    await opfs.deletePath(`jobs/${job.id}`).catch(() => undefined);
    throw err;
  }

  // Fresh row in this browser: revision tracking restarts.
  job.editRev = 0;
  await jobsDb.saveJob(job);
  emitJobUpdate(job);
  return { jobId: job.id, title: job.title };
}
