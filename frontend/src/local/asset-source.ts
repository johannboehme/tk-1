/**
 * Asset-source abstraction.
 *
 * A media asset can live in one of two places:
 *
 *   - OPFS — the file's bytes are copied into the origin-private file
 *     system at upload. Persistent across reloads and tab restarts;
 *     no permission prompts. Costs the entire file size in disk space.
 *     Used as the fallback for browsers without the File System Access
 *     API (Safari, Firefox until they ship `showOpenFilePicker`).
 *
 *   - User's disk — we hold a `FileSystemFileHandle` referencing the
 *     original file the user picked. Persisted natively in IndexedDB
 *     via structured clone; survives reloads. No copy of the bytes.
 *     The browser may require the user to re-grant read access on
 *     fresh page loads (we surface that as a UI step).
 *
 * The `source` field on `VideoAsset` / `ImageAsset` / `LocalJob` is the
 * discriminator. Older rows (v2 schema) don't have `source` and use
 * `opfsPath` directly — `loadAssetFile()` handles both.
 */

import { opfs } from "../storage/opfs";

export type AssetSource =
  | { kind: "opfs"; path: string }
  | { kind: "handle"; handle: FileSystemFileHandle };

/** Resolve an asset source to a `File` ready to read. For handle
 *  sources, requires that read permission is currently granted —
 *  callers expecting cold-load conditions must call
 *  `ensureReadPermission` first inside a user gesture. Throws a
 *  recognisable error string when permission is missing so the editor
 *  shell can prompt for re-acquire. */
export async function loadAsset(source: AssetSource): Promise<File> {
  if (source.kind === "opfs") return opfs.readFile(source.path);
  const perm = await safeQueryPermission(source.handle);
  if (perm !== "granted") {
    throw new AssetPermissionError(source.handle.name, perm);
  }
  return await source.handle.getFile();
}

/** Asset record shape that may hold either a structured `source` (v3+)
 *  or only the legacy `opfsPath` (v2 rows). */
export interface AssetRecord {
  source?: AssetSource;
  opfsPath?: string;
}

/** Resolve an asset record (the schema-tolerant front door used by
 *  every read site in the codebase). */
export async function loadAssetFile(asset: AssetRecord): Promise<File> {
  if (asset.source) return loadAsset(asset.source);
  if (asset.opfsPath) return opfs.readFile(asset.opfsPath);
  throw new Error("Asset has neither `source` nor `opfsPath`");
}

/** Asset record returned by `pickXxx()` — either a fresh user-disk
 *  handle (preferred when available) or a plain File from the legacy
 *  `<input>` path (caller will write to OPFS). */
export interface PickedAsset {
  file: File;
  /** Preferred persistent source. When `null`, the caller should
   *  persist the file's bytes to OPFS and record an `opfs` source. */
  handle: FileSystemFileHandle | null;
}

/** Decide where to persist an asset. Returns the source to record on
 *  the asset row. For handle-backed picks, no IO happens — the handle
 *  itself is the source. For File-only picks (legacy), this writes to
 *  OPFS at the given path. */
export async function persistPickedAsset(
  picked: PickedAsset,
  opfsPath: string,
): Promise<AssetSource> {
  if (picked.handle) {
    return { kind: "handle", handle: picked.handle };
  }
  await opfs.writeFile(opfsPath, picked.file);
  return { kind: "opfs", path: opfsPath };
}

/** Delete asset bytes if we own them (OPFS). Handle-backed assets are
 *  the user's files — we never delete those. Idempotent. */
export async function deleteAssetIfOwned(source: AssetSource): Promise<void> {
  if (source.kind === "opfs") {
    await opfs.deleteFile(source.path);
  }
  // handle-backed: nothing to do; the user's file stays where it is.
}

/** Check whether we currently have read permission for a handle.
 *  Returns "n/a" for non-handle sources (always usable). */
export async function checkReadPermission(
  source: AssetSource,
): Promise<"granted" | "denied" | "prompt" | "n/a"> {
  if (source.kind === "opfs") return "n/a";
  return await safeQueryPermission(source.handle);
}

/** Request read permission for a handle. MUST be called from within a
 *  user gesture (click, key, etc.) — browsers reject the prompt
 *  otherwise. Returns the new state. No-op for non-handle sources. */
export async function requestReadPermission(
  source: AssetSource,
): Promise<"granted" | "denied" | "prompt"> {
  if (source.kind === "opfs") return "granted";
  const handle = source.handle as FileSystemFileHandle & {
    requestPermission?: (opts: {
      mode: "read" | "readwrite";
    }) => Promise<PermissionState>;
  };
  if (typeof handle.requestPermission !== "function") return "denied";
  try {
    const result = await handle.requestPermission({ mode: "read" });
    return result;
  } catch {
    return "denied";
  }
}

async function safeQueryPermission(
  handle: FileSystemFileHandle,
): Promise<"granted" | "denied" | "prompt"> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (opts: {
      mode: "read" | "readwrite";
    }) => Promise<PermissionState>;
  };
  if (typeof h.queryPermission !== "function") {
    // Fallback: assume granted in the same session as the pick.
    return "granted";
  }
  try {
    return await h.queryPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

export class AssetPermissionError extends Error {
  readonly code = "permission-required" as const;
  constructor(public readonly fileName: string, public readonly state: string) {
    super(
      `Read permission for "${fileName}" is ${state} — user must re-grant ` +
        `access via a click before the file can be loaded.`,
    );
    this.name = "AssetPermissionError";
  }
}
