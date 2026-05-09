/**
 * Sync-failure diagnostic report.
 *
 * Sammelt zur Fail-Zeit alles was uns hilft, einen Bug-Report vom User
 * zu triagen ohne zurückfragen zu müssen: originaler Error inkl. Name +
 * Stack, welcher File grade in der Mache war, Browser-/OS-Fingerprint,
 * Capability-Snapshot, OPFS-Quota.
 *
 * Output ist plaintext, copy-paste-tauglich. Bewusst kein JSON — der
 * User soll's auch ohne Tools lesen können (Discord, Mail).
 *
 * Gegenstück zum generischen "File could not be read! Code=-1" Banner:
 * der Banner zeigt nur die summary-Zeile, der full report wird per
 * "Show details" aus-/eingeklappt.
 */

import { getCapabilities, type Capabilities } from "./capabilities";
import { useOpsStore, type SyncOpFileContext } from "./ops-store";

const STACK_FRAME_LIMIT = 5;

export interface SyncFailureReport {
  /** One-liner suitable for the inline error banner. Carries stage +
   *  the first line of the error message (truncated). */
  summary: string;
  /** Multi-line plaintext report — what the user copies into a bug
   *  report. Includes everything in `data` formatted for humans. */
  report: string;
  /** Structured copy of the report, exposed for tests/telemetry. */
  data: SyncFailureData;
}

export interface SyncFailureData {
  jobId: string;
  stage: string;
  whenIso: string;
  error: { name: string; message: string; stack: string[] };
  file?: SyncOpFileContext;
  browser: { userAgent: string; platform: string; language: string };
  capabilities: Capabilities;
  storage?: { usage?: number; quota?: number };
}

/**
 * Build a failure report for the given job + thrown error. Reads the
 * current sync-op state for stage + the file-in-flight, plus the live
 * capability snapshot and OPFS quota. Pure async — never throws (a
 * broken diagnostic step is degraded to "unknown" so we don't lose the
 * original error).
 */
export async function collectSyncFailureReport(
  jobId: string,
  err: unknown,
): Promise<SyncFailureReport> {
  const op = useOpsStore.getState().ops[jobId]?.sync;
  const stage = op?.stage ?? "unknown";
  const file = op?.currentFile;

  const error = normaliseError(err);
  const browser = readBrowser();
  const capabilities = getCapabilities();
  const storage = await readStorage();

  const data: SyncFailureData = {
    jobId,
    stage,
    whenIso: new Date().toISOString(),
    error,
    file,
    browser,
    capabilities,
    storage,
  };

  return {
    summary: buildSummary(stage, error),
    report: formatReport(data),
    data,
  };
}

function normaliseError(err: unknown): SyncFailureData["error"] {
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: err.message || String(err),
      stack: parseStackFrames(err.stack),
    };
  }
  return { name: typeof err, message: String(err), stack: [] };
}

function parseStackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  // V8 prefixes with "<Name>: <message>" line; non-V8 (Safari) starts
  // straight with the frames. Drop any prefix that doesn't look like a
  // frame (no leading "at " AND no "@" — Safari uses `fn@url:line:col`).
  const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
  const frames = lines.filter((l) => l.startsWith("at ") || l.includes("@"));
  return (frames.length > 0 ? frames : lines).slice(0, STACK_FRAME_LIMIT);
}

function readBrowser(): SyncFailureData["browser"] {
  if (typeof navigator === "undefined") {
    return { userAgent: "unknown", platform: "unknown", language: "unknown" };
  }
  const nav = navigator as Navigator & { platform?: string };
  return {
    userAgent: nav.userAgent ?? "unknown",
    platform: nav.platform ?? "unknown",
    language: nav.language ?? "unknown",
  };
}

async function readStorage(): Promise<SyncFailureData["storage"]> {
  if (typeof navigator === "undefined") return undefined;
  const storage = navigator.storage as
    | (StorageManager & { estimate?: () => Promise<StorageEstimate> })
    | undefined;
  if (!storage?.estimate) return undefined;
  try {
    const est = await storage.estimate();
    return { usage: est.usage, quota: est.quota };
  } catch {
    return undefined;
  }
}

function buildSummary(stage: string, error: SyncFailureData["error"]): string {
  const firstLine = error.message.split("\n")[0].slice(0, 200);
  const stagePart = stage && stage !== "unknown" ? `[${stage}] ` : "";
  return `${stagePart}${error.name}: ${firstLine}`;
}

const SECTION_RULE = "----------------------------------------";

/** Plaintext formatter — one column, fixed-width labels, no markdown. */
export function formatReport(data: SyncFailureData): string {
  const lines: string[] = [];
  lines.push("videoaudiosync — sync failure report");
  lines.push("====================================");
  lines.push(`Job:    ${data.jobId}`);
  lines.push(`Stage:  ${data.stage}`);
  lines.push(`When:   ${data.whenIso}`);
  lines.push("");

  lines.push("Error");
  lines.push(SECTION_RULE);
  lines.push(`Name:    ${data.error.name}`);
  lines.push(`Message: ${data.error.message}`);
  if (data.error.stack.length > 0) {
    lines.push("Stack:");
    for (const frame of data.error.stack) lines.push(`  ${frame}`);
  }
  lines.push("");

  if (data.file) {
    lines.push("File in flight");
    lines.push(SECTION_RULE);
    lines.push(`Name:   ${data.file.name}`);
    lines.push(`Size:   ${formatBytes(data.file.size)}`);
    lines.push(`Type:   ${data.file.type || "unknown"}`);
    lines.push(`Source: ${data.file.sourceKind}`);
    lines.push("");
  }

  lines.push("Browser");
  lines.push(SECTION_RULE);
  lines.push(`UA:       ${data.browser.userAgent}`);
  lines.push(`Platform: ${data.browser.platform}`);
  lines.push(`Language: ${data.browser.language}`);
  lines.push("");

  lines.push("Capabilities");
  lines.push(SECTION_RULE);
  const c = data.capabilities;
  lines.push(`WebCodecs (audio):  ${yn(c.audioDecoder)}`);
  lines.push(`WebCodecs (video):  ${yn(c.videoDecoder)}`);
  lines.push(`WebCodecs encoders: audio=${yn(c.audioEncoder)} video=${yn(c.videoEncoder)}`);
  lines.push(`OPFS:               ${yn(c.opfs)}`);
  lines.push(`WebAssembly:        ${yn(c.webAssembly)}`);
  lines.push(`SharedArrayBuffer:  ${yn(c.sharedArrayBuffer)}`);
  lines.push(`Cross-origin iso:   ${yn(c.crossOriginIsolated)}`);
  lines.push(`File System Access: ${yn(c.fileSystemAccess)}`);
  lines.push(`WebGL2:             ${yn(c.webgl2)}`);
  lines.push(`WebGPU:             ${yn(c.webgpu)}`);
  lines.push("");

  if (data.storage) {
    lines.push("Storage");
    lines.push(SECTION_RULE);
    lines.push(`Used:  ${formatBytes(data.storage.usage)}`);
    lines.push(`Quota: ${formatBytes(data.storage.quota)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 2 : 1)} ${units[i]}`;
}
