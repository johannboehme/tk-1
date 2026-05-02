import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { RuleStrip } from "../editor/components/RuleStrip";
import { formatBytes } from "../components/ProgressBar";
import { createJob } from "../local/jobs";
import {
  getCapabilities,
  LEGACY_BROWSER_MAX_FILE_BYTES,
  supportsLargeMediaFiles,
} from "../local/capabilities";

export default function Upload() {
  const navigate = useNavigate();
  const [audio, setAudio] = useState<File | null>(null);
  const [videos, setVideos] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Snapshot once at mount: capabilities are static within a tab.
  const caps = useMemo(getCapabilities, []);
  const supportsBig = supportsLargeMediaFiles(caps);

  const ready = audio !== null && videos.length > 0 && !busy;

  function rejectIfTooBigForBrowser(file: File, kind: "audio" | "video"): string | null {
    if (supportsBig) return null;
    if (file.size <= LEGACY_BROWSER_MAX_FILE_BYTES) return null;
    return (
      `${kind === "audio" ? "Audio" : "Video"} file "${file.name}" is ` +
      `${formatGiB(file.size)} — your browser caps each file at ` +
      `${formatGiB(LEGACY_BROWSER_MAX_FILE_BYTES)} because WebCodecs ` +
      `decoders aren't available. Try Chrome / Edge / Brave for files ` +
      `over 2 GB, or re-encode at a lower bitrate.`
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!audio || videos.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const jobId = await createJob(videos, audio, { title: title || null });
      navigate(`/job/${jobId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the project");
      setBusy(false);
    }
  }

  function setAudioGuarded(file: File | null) {
    if (file) {
      const msg = rejectIfTooBigForBrowser(file, "audio");
      if (msg) {
        setErr(msg);
        return;
      }
    }
    setErr(null);
    setAudio(file);
  }

  function addVideos(files: FileList | null) {
    if (!files) return;
    const next = Array.from(files);
    for (const f of next) {
      const msg = rejectIfTooBigForBrowser(f, "video");
      if (msg) {
        setErr(msg);
        return;
      }
    }
    setErr(null);
    setVideos((prev) => [...prev, ...next]);
  }

  function removeVideo(idx: number) {
    setVideos((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <header className="grid lg:grid-cols-[1.4fr_1fr] gap-6 lg:gap-12 mb-8 lg:mb-12">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="font-mono text-xs tracking-label uppercase text-ink-2">
              NEW · CLIP-STUDIO · LOCAL
            </span>
            <RuleStrip count={32} className="text-rule flex-1 max-w-[220px]" />
          </div>
          <h1 className="font-display font-semibold text-[clamp(40px,6vw,80px)] leading-[0.95] tracking-tight text-ink">
            Drop the song.<br />
            Drop your videos.<br />
            <span className="text-hot">Build the cut.</span>
          </h1>
        </div>
        <aside className="lg:pt-12 flex flex-col gap-3 text-sm text-ink-2 lg:max-w-xs">
          <p className="leading-relaxed">
            One master audio file. As many video angles, takes, or B-roll
            clips as you have. We'll sync them all to the song and open the
            multi-track editor.
          </p>
          <p className="leading-relaxed">
            Everything stays in your browser. Modern Chromium browsers (Chrome,
            Edge, Brave, Arc) are fastest; Firefox + Safari fall back to
            ffmpeg.wasm for some codecs.
          </p>
        </aside>
      </header>

      {!supportsBig && (
        <div className="mb-6 border-l-2 border-cobalt pl-3 py-2 text-sm text-ink-2 font-mono">
          Heads-up: this browser can only decode files up to{" "}
          {formatGiB(LEGACY_BROWSER_MAX_FILE_BYTES)} each (no WebCodecs
          AudioDecoder/VideoDecoder yet). Chrome, Edge or Brave handle
          arbitrarily large files via streaming decode.
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <div className="grid lg:grid-cols-[1fr_1.6fr] gap-3 items-stretch">
          <AudioDropZone file={audio} onChange={setAudioGuarded} />
          <VideoDropList files={videos} onAdd={addVideos} onRemove={removeVideo} />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-1">
          <label htmlFor="job-title" className="label sm:w-32 sm:shrink-0 sm:pt-0">
            Title <span className="text-ink-3 normal-case tracking-normal">(opt.)</span>
          </label>
          <input
            id="job-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Take 1, B-side rehearsal, …"
            className="h-11 flex-1 bg-paper-hi border border-rule rounded-md px-3 font-mono text-sm focus:border-cobalt focus:outline-none focus:ring-2 focus:ring-cobalt/30"
          />
        </div>

        {err && (
          <div className="border-l-2 border-danger pl-3 py-2 text-sm text-danger font-mono">
            {err}
          </div>
        )}

        <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-stretch border-t border-rule pt-5 mt-2">
          <ReadinessStatus audio={audio} videos={videos} busy={busy} />
          <ChunkyButton
            type="submit"
            variant="primary"
            size="lg"
            disabled={!ready}
            className="sm:min-w-[200px]"
          >
            {busy ? "Preparing…" : "Sync & open editor"}
          </ChunkyButton>
        </div>
      </form>
    </main>
  );
}

function AudioDropZone({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const filled = file !== null;
  return (
    <label
      htmlFor="picker-audio"
      className={[
        "relative block rounded-lg cursor-pointer transition-colors group",
        "border-2 border-dashed min-h-[220px]",
        filled ? "bg-hot/10 border-hot text-ink" : "bg-paper-hi border-rule hover:border-ink-2 hover:bg-paper-deep",
      ].join(" ")}
    >
      <div className="absolute top-4 left-5 right-5 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[11px] text-ink-2">
          01 · Master audio
        </span>
        {filled && (
          <span className="font-mono text-[10px] tracking-label uppercase text-hot">
            ● READY
          </span>
        )}
      </div>
      <div className="absolute inset-0 flex items-end justify-between p-5 pt-14">
        <div className="min-w-0 flex-1">
          {filled ? (
            <>
              <div className="font-mono text-base sm:text-lg text-ink truncate">
                {file!.name}
              </div>
              <div className="mt-1 font-mono text-xs text-ink-2 tabular">
                {formatBytes(file!.size)}
              </div>
            </>
          ) : (
            <div className="font-display text-2xl sm:text-3xl font-semibold text-ink-3 leading-tight">
              Drop song
              <br />
              <span className="text-base sm:text-lg font-normal text-ink-3">
                or tap to pick
              </span>
            </div>
          )}
        </div>
      </div>
      <input
        id="picker-audio"
        type="file"
        accept="audio/*"
        className="sr-only"
        onChange={(e) => onChange(e.target.files?.[0] || null)}
      />
    </label>
  );
}

function VideoDropList({
  files,
  onAdd,
  onRemove,
}: {
  files: File[];
  onAdd: (list: FileList | null) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="rounded-lg border-2 border-dashed border-rule bg-paper-hi p-3 sm:p-4 flex flex-col gap-2 min-h-[220px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-display tracking-label uppercase text-[11px] text-ink-2">
          02 · Video sources
        </span>
        {files.length > 0 && (
          <span className="font-mono text-[10px] tracking-label uppercase text-hot">
            ● {files.length} READY
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {files.map((f, i) => (
          <li
            key={`${f.name}-${i}`}
            className="flex items-center gap-3 px-3 h-11 bg-paper-deep border border-rule rounded-md"
          >
            <span className="font-mono text-xs text-ink-3 tabular w-8">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="font-mono text-sm text-ink truncate flex-1">{f.name}</span>
            <span className="font-mono text-xs text-ink-3 tabular hidden sm:inline">
              {formatBytes(f.size)}
            </span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="font-mono text-[11px] text-ink-3 hover:text-danger uppercase tracking-label"
              aria-label={`Remove ${f.name}`}
            >
              remove
            </button>
          </li>
        ))}
      </ul>

      <label
        htmlFor="picker-videos"
        className={[
          "mt-auto flex items-center justify-center gap-3 h-12 rounded-md cursor-pointer transition-colors",
          "border border-dashed",
          files.length === 0
            ? "border-rule text-ink-3 bg-transparent hover:border-ink-2 hover:text-ink-2"
            : "border-rule text-ink-2 hover:border-ink-2 hover:text-ink",
        ].join(" ")}
      >
        <span className="text-xl leading-none">+</span>
        <span className="font-mono text-xs tracking-label uppercase">
          {files.length === 0 ? "Add videos (multi-select ok)" : "Add another"}
        </span>
      </label>
      <input
        id="picker-videos"
        type="file"
        accept="video/*"
        multiple
        className="sr-only"
        onChange={(e) => onAdd(e.target.files)}
      />
    </div>
  );
}

function ReadinessStatus({
  audio,
  videos,
  busy,
}: {
  audio: File | null;
  videos: File[];
  busy: boolean;
}) {
  return (
    <div className="bg-paper-hi border border-rule rounded-md px-4 py-2.5 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <Dot ok={audio !== null} label="AUDIO" />
        <Dot ok={videos.length > 0} label={`VIDEO · ${videos.length}`} />
      </div>
      <span className="font-mono text-[10px] tracking-label uppercase text-ink-3">
        {busy ? "PREPARING" : audio && videos.length > 0 ? "READY → SYNC" : "WAITING"}
      </span>
    </div>
  );
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-label uppercase">
      <span
        className={[
          "inline-block w-2 h-2 rounded-full",
          ok ? "bg-hot" : "bg-rule",
        ].join(" ")}
      />
      <span className={ok ? "text-ink" : "text-ink-3"}>{label}</span>
    </span>
  );
}
