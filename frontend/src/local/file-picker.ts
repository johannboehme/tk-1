/**
 * Capability-aware file picker.
 *
 * Modern path (Chrome, Edge, Brave): `window.showOpenFilePicker()` →
 * returns `FileSystemFileHandle`s that can be persisted in IndexedDB
 * and re-acquired across sessions. No copy of the file's bytes.
 *
 * Fallback path (Safari, Firefox until they ship the API): create an
 * ephemeral `<input type="file">` programmatically, click it, await
 * the change event. Returns plain `File`s — caller will copy bytes
 * to OPFS.
 *
 * Both paths return the same `PickedAsset[]` shape so the rest of the
 * pipeline doesn't fork.
 *
 * MUST be invoked from a user gesture (click handler). The browser
 * rejects the picker otherwise.
 */

import type { PickedAsset } from "./asset-source";

export interface PickerOptions {
  multiple?: boolean;
}

const VIDEO_MIME = "video/*";
const IMAGE_MIME = "image/*";
const AUDIO_MIME = "audio/*";

export async function pickVideoOrImageFiles(
  opts: PickerOptions = {},
): Promise<PickedAsset[]> {
  return pickWithCapability({
    multiple: opts.multiple ?? true,
    inputAccept: `${VIDEO_MIME},${IMAGE_MIME}`,
    fsTypes: [
      {
        description: "Video / image",
        accept: {
          "video/*": [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"],
          "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"],
        },
      },
    ],
  });
}

export async function pickVideoFiles(
  opts: PickerOptions = {},
): Promise<PickedAsset[]> {
  return pickWithCapability({
    multiple: opts.multiple ?? true,
    inputAccept: VIDEO_MIME,
    fsTypes: [
      {
        description: "Video",
        accept: {
          "video/*": [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"],
        },
      },
    ],
  });
}

export async function pickAudioFile(): Promise<PickedAsset | null> {
  const list = await pickWithCapability({
    multiple: false,
    inputAccept: AUDIO_MIME,
    fsTypes: [
      {
        description: "Audio",
        accept: {
          "audio/*": [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"],
        },
      },
    ],
  });
  return list[0] ?? null;
}

/** Whether this browser exposes `showOpenFilePicker`. When false we
 *  fall back to a hidden `<input type=file>`, which means uploads are
 *  copied into OPFS instead of held as native handles. */
export function supportsHandlePicker(): boolean {
  return typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    === "function";
}

interface FsAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface UnifiedPickArgs {
  multiple: boolean;
  inputAccept: string;
  fsTypes: FsAcceptType[];
}

async function pickWithCapability(args: UnifiedPickArgs): Promise<PickedAsset[]> {
  if (supportsHandlePicker()) {
    return await pickViaFileSystemAccess(args);
  }
  return await pickViaInput(args);
}

interface FileSystemAccessGlobal {
  showOpenFilePicker: (opts: {
    multiple?: boolean;
    types?: FsAcceptType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
}

async function pickViaFileSystemAccess(
  args: UnifiedPickArgs,
): Promise<PickedAsset[]> {
  const w = window as unknown as FileSystemAccessGlobal;
  let handles: FileSystemFileHandle[];
  try {
    handles = await w.showOpenFilePicker({
      multiple: args.multiple,
      types: args.fsTypes,
      excludeAcceptAllOption: false,
    });
  } catch (err) {
    // AbortError fires when the user cancels the picker — surface as
    // an empty result (caller treats it as "nothing was picked").
    if ((err as { name?: string }).name === "AbortError") return [];
    throw err;
  }
  const out: PickedAsset[] = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    out.push({ file, handle });
  }
  return out;
}

function pickViaInput(args: UnifiedPickArgs): Promise<PickedAsset[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = args.inputAccept;
    input.multiple = args.multiple;
    input.style.display = "none";
    document.body.appendChild(input);

    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      input.remove();
    };

    let didChange = false;
    input.addEventListener("change", () => {
      didChange = true;
      const files = Array.from(input.files ?? []);
      cleanup();
      resolve(files.map((file) => ({ file, handle: null })));
    });

    // Detect cancel: when the picker closes without a selection, focus
    // returns to the window. We give the browser one tick to fire
    // `change` first; if it doesn't, treat as "nothing picked".
    const onFocus = () => {
      setTimeout(() => {
        if (didChange) return;
        cleanup();
        resolve([]);
      }, 200);
    };
    window.addEventListener("focus", onFocus, { once: true });

    try {
      input.click();
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}
