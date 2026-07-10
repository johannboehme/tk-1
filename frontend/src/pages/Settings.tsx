import { useEffect, useRef, useState } from "react";
import { type Capabilities, describeCapability, meetsMinRequirements } from "../local/capabilities";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import {
  exportProjectArchive,
  importProjectArchive,
} from "../local/project-archive";
import { formatBytesShort } from "../local/quota-consent";
import { jobsDb, type LocalJob } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";

const ALL_KEYS: ReadonlyArray<keyof Capabilities> = [
  "webAssembly",
  "sharedArrayBuffer",
  "crossOriginIsolated",
  "opfs",
  "audioDecoder",
  "videoDecoder",
  "audioEncoder",
  "videoEncoder",
  "fileSystemAccess",
  "webgl2",
  "webgpu",
];

interface RenderPath {
  label: string;
  detail: string;
}

function pickRenderPath(caps: Capabilities): RenderPath {
  if (caps.videoEncoder && caps.audioEncoder) {
    return {
      label: "WebCodecs (HW)",
      detail: "Hardware-accelerated H.264 + AAC via the browser's native codecs.",
    };
  }
  if (caps.audioDecoder && caps.videoDecoder) {
    return {
      label: "ffmpeg.wasm encode + WebCodecs decode",
      detail:
        "The browser cannot encode video natively yet, so encoding falls back to ffmpeg.wasm in the browser.",
    };
  }
  return {
    label: "ffmpeg.wasm",
    detail:
      "Both decode and encode run via ffmpeg.wasm in the browser. Slower than WebCodecs, still upload-free.",
  };
}

function pickRenderBackend(caps: Capabilities): RenderPath {
  if (caps.webgpu) {
    return {
      label: "WebGPU",
      detail:
        "State-of-the-art GPU compositing — preview and export both render Layer + FX through WGSL shaders. Same backend code, same pixels in both paths.",
    };
  }
  if (caps.webgl2) {
    return {
      label: "WebGL2",
      detail:
        "Fallback GPU path. Same Layer + FX pipeline as WebGPU, GLSL shaders. Used when WebGPU adapter unavailable.",
    };
  }
  return {
    label: "Canvas2D",
    detail:
      "Floor fallback (CPU compositing). Some FX (WEAR static, sat/luma wobble) ship reduced fidelity here — accept it on legacy browsers.",
  };
}

interface SettingsProps {
  caps: Capabilities;
}

export function Settings({ caps }: SettingsProps) {
  const min = meetsMinRequirements(caps);
  const renderPath = pickRenderPath(caps);
  const renderBackend = pickRenderBackend(caps);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <header>
        <h1 className="text-3xl font-semibold">Settings</h1>
        <p className="text-sm opacity-70">
          What this browser can do, and how this app will use it.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Status</h2>
        <div data-testid="min-status" className="rounded-lg border p-4">
          {min.ok ? (
            <>
              <strong>Ready.</strong> All minimum requirements are met.
            </>
          ) : (
            <>
              <strong>Not ready.</strong> Missing:{" "}
              {min.missing.map(describeCapability).join(", ")}.
            </>
          )}
        </div>
        <div data-testid="render-path" className="rounded-lg border p-4">
          <div className="text-sm uppercase opacity-70">Render path</div>
          <div className="font-mono text-base">{renderPath.label}</div>
          <p className="mt-1 text-sm opacity-80">{renderPath.detail}</p>
        </div>
        <div data-testid="render-backend" className="rounded-lg border p-4">
          <div className="text-sm uppercase opacity-70">Render backend</div>
          <div className="font-mono text-base">{renderBackend.label}</div>
          <p className="mt-1 text-sm opacity-80">{renderBackend.detail}</p>
        </div>
      </section>

      <ProjectsBackupSection />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Browser capabilities</h2>
        <ul className="divide-y rounded-lg border">
          {ALL_KEYS.map((key) => (
            <li
              key={key}
              className="flex items-center justify-between px-4 py-2 text-sm"
              data-testid={`cap-${key}`}
            >
              <span>{describeCapability(key)}</span>
              <span className="font-mono">{caps[key] ? "✓" : "✗"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects — backup / restore (#86)
// ---------------------------------------------------------------------------

interface ProjectRow {
  job: LocalJob;
  bytes: number | null;
}

/** Keep the last export's object URL alive until the next export — an
 *  archive Blob backed by OPFS files may still be streaming to disk, so
 *  revoking eagerly could truncate a large download. */
let lastExportUrl: string | null = null;

function triggerDownload(blob: Blob, filename: string): void {
  if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
  const url = URL.createObjectURL(blob);
  lastExportUrl = url;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Per-project backup and restore. Everything a project is — edits, sync
 * results, media copies, the rendered output — lives in this browser
 * profile's storage; the archive is the only way to survive a 'Clear
 * site data', move to another machine, or hand a project to someone
 * else.
 */
function ProjectsBackupSection() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    try {
      const jobs = await jobsDb.listJobs();
      const withSizes: ProjectRow[] = [];
      for (const job of jobs) {
        let bytes: number | null = null;
        try {
          bytes = (await opfs.dirStats(`jobs/${job.id}`)).bytes;
        } catch {
          // size unknown — still exportable
        }
        withSizes.push({ job, bytes });
      }
      setRows(withSizes);
    } catch {
      setRows([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onExport(job: LocalJob): Promise<void> {
    setBusy(job.id);
    setErr(null);
    setMsg(null);
    try {
      const { blob, filename } = await exportProjectArchive(job.id);
      triggerDownload(blob, filename);
      setMsg(`Exported "${job.title || job.id}" as ${filename}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function onImportFile(file: File): Promise<void> {
    setBusy("import");
    setErr(null);
    setMsg(null);
    try {
      const imported = await importProjectArchive(file);
      setMsg(
        `Imported "${imported.title || imported.jobId}" — find it under History.`,
      );
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3" data-testid="projects-backup">
      <h2 className="text-lg font-medium">Projects</h2>
      <p className="text-sm opacity-70">
        Back up a project as a single archive file — edits, media, and the
        rendered output — or restore one here or in any other browser.
      </p>
      <div className="rounded-lg border divide-y">
        {rows === null ? (
          <div className="px-4 py-3 text-sm opacity-70">Loading projects…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-3 text-sm opacity-70">No projects yet.</div>
        ) : (
          rows.map(({ job, bytes }) => (
            <div
              key={job.id}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              data-testid={`backup-row-${job.id}`}
            >
              <div className="min-w-0">
                <div className="truncate">{job.title || job.id}</div>
                <div className="font-mono text-xs opacity-60">
                  {new Date(job.createdAt).toLocaleDateString()}
                  {bytes !== null ? ` · ${formatBytesShort(bytes)}` : ""}
                </div>
              </div>
              <ChunkyButton
                size="sm"
                onClick={() => void onExport(job)}
                disabled={busy !== null}
              >
                {busy === job.id ? "Exporting…" : "Export"}
              </ChunkyButton>
            </div>
          ))
        )}
        <div className="flex items-center gap-3 px-4 py-3">
          <ChunkyButton
            size="sm"
            variant="primary"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
          >
            {busy === "import" ? "Importing…" : "Import archive"}
          </ChunkyButton>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="Project archive file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onImportFile(file);
            }}
          />
          <span className="text-xs opacity-60">Accepts .tk1.zip archives</span>
        </div>
      </div>
      {msg && (
        <div className="text-sm" data-testid="backup-msg">
          {msg}
        </div>
      )}
      {err && (
        <div className="text-sm text-danger" data-testid="backup-err">
          {err}
        </div>
      )}
    </section>
  );
}
