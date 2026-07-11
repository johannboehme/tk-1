/**
 * Drag & drop support for the Upload page.
 *
 * Pure, unit-testable helpers: classify what was dropped (audio → song
 * slot, video → cam list) and read `PickedAsset`s out of a drop's
 * `DataTransfer`. On Chromium we grab `FileSystemFileHandle`s via
 * `DataTransferItem.getAsFileSystemHandle()` so dropped files keep the
 * same no-copy persistence path as files chosen through
 * `showOpenFilePicker()`; everywhere else we fall back to plain `File`s
 * (caller copies bytes to OPFS, same as the `<input type=file>` path).
 */

import type { PickedAsset } from "../local/asset-source";

export type MediaKind = "audio" | "video";

/** Extension fallbacks for files that arrive without a MIME type.
 *  Mirrors the accept lists in `local/file-picker.ts`. */
const AUDIO_EXTENSIONS = new Set([
  "wav",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "aif",
  "aiff",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
  "avi",
]);

/** Classify a dropped file as song material, cam material, or neither.
 *  MIME type wins; extension is the fallback for files the OS didn't
 *  tag (common for `.mkv`, some `.mov`). */
export function classifyMediaKind(file: File): MediaKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  const dot = file.name.lastIndexOf(".");
  if (dot < 0 || dot === file.name.length - 1) return null;
  const ext = file.name.slice(dot + 1).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

export interface DropPartition {
  audio: PickedAsset[];
  videos: PickedAsset[];
  ignored: PickedAsset[];
}

/** Split a dropped batch by media kind, preserving drop order within
 *  each bucket. The caller decides what to do with multiple audio files
 *  (Upload takes the first one as the song). */
export function partitionDroppedAssets(assets: readonly PickedAsset[]): DropPartition {
  const out: DropPartition = { audio: [], videos: [], ignored: [] };
  for (const asset of assets) {
    const kind = classifyMediaKind(asset.file);
    if (kind === "audio") out.audio.push(asset);
    else if (kind === "video") out.videos.push(asset);
    else out.ignored.push(asset);
  }
  return out;
}

/** Whether a drag carries files (vs. dragged text / links). During
 *  `dragover` the file list itself is not readable — `types` is the
 *  only reliable signal. */
export function dataTransferHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes("Files");
}

interface HandleCapableItem extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<
    | (FileSystemHandle & { getFile?: () => Promise<File> })
    | null
  >;
}

/**
 * Read the dropped files out of a `DataTransfer` as `PickedAsset`s.
 *
 * MUST be called synchronously from the drop handler: the item list is
 * neutered once the event handler returns, so both `getAsFile()` and
 * the `getAsFileSystemHandle()` promises are captured up front before
 * anything is awaited.
 *
 * Directories (folder drops) are skipped — only file handles/files are
 * returned.
 */
export async function readDroppedAssets(dt: DataTransfer): Promise<PickedAsset[]> {
  const items = Array.from(dt.items ?? []) as HandleCapableItem[];
  const fileItems = items.filter((it) => it.kind === "file");

  // No item interface (jsdom, very old engines): plain files only.
  if (fileItems.length === 0) {
    return Array.from(dt.files ?? []).map((file) => ({ file, handle: null }));
  }

  // Capture everything synchronously, then resolve.
  const captures = fileItems.map((it) => ({
    file: typeof it.getAsFile === "function" ? it.getAsFile() : null,
    handlePromise:
      typeof it.getAsFileSystemHandle === "function"
        ? it.getAsFileSystemHandle().catch(() => null)
        : Promise.resolve(null),
  }));

  const out: PickedAsset[] = [];
  for (const cap of captures) {
    const handle = await cap.handlePromise;
    if (handle && handle.kind === "file" && typeof handle.getFile === "function") {
      const fsHandle = handle as FileSystemFileHandle;
      try {
        out.push({ file: await fsHandle.getFile(), handle: fsHandle });
        continue;
      } catch {
        // fall through to the plain-File fallback
      }
    }
    if (cap.file) out.push({ file: cap.file, handle: null });
    // else: directory or non-file item without a File — skip.
  }
  return out;
}
