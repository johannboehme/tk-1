import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RuleStrip } from "../editor/components/RuleStrip";
import { formatBytes } from "../components/ProgressBar";
import { createJob } from "../local/jobs";
import type { JobMode } from "../local/jobs";
import type { PickedAsset } from "../local/asset-source";
import {
  pickAudioFile,
  pickVideoFiles,
  supportsHandlePicker,
} from "../local/file-picker";
import {
  getCapabilities,
  LEGACY_BROWSER_MAX_FILE_BYTES,
  supportsLargeMediaFiles,
} from "../local/capabilities";

export default function Upload() {
  const navigate = useNavigate();
  const [audio, setAudio] = useState<PickedAsset | null>(null);
  const [videos, setVideos] = useState<PickedAsset[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Snapshot once at mount: capabilities are static within a tab.
  const caps = useMemo(getCapabilities, []);
  const supportsBig = supportsLargeMediaFiles(caps);
  const usesHandles = supportsHandlePicker();

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

  async function handleSubmit(mode: JobMode) {
    if (!audio || videos.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const jobId = await createJob(videos, audio, {
        title: title || null,
        mode,
      });
      // Both modes go to /job/:id first — sync needs to run before
      // any further phase. Triage's silence detection wants the
      // decoded master audio, BPM-per-chunk wants audio analysis,
      // and Cam-Preview wants the per-cam frame strips. JobPage's
      // "Continue → Triage" / "Open editor" button (driven by
      // nextRouteForJob) takes over once sync completes.
      navigate(`/job/${jobId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the project");
      setBusy(false);
    }
  }

  async function pickAudioGuarded() {
    try {
      const picked = await pickAudioFile();
      if (!picked) return; // user cancelled
      const msg = rejectIfTooBigForBrowser(picked.file, "audio");
      if (msg) {
        setErr(msg);
        return;
      }
      setErr(null);
      setAudio(picked);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not open audio file");
    }
  }

  async function pickVideosGuarded() {
    try {
      const picked = await pickVideoFiles({ multiple: true });
      if (picked.length === 0) return; // user cancelled
      for (const p of picked) {
        const msg = rejectIfTooBigForBrowser(p.file, "video");
        if (msg) {
          setErr(msg);
          return;
        }
      }
      setErr(null);
      setVideos((prev) => [...prev, ...picked]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not open video files");
    }
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

      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-col gap-6"
      >
        <div className="grid lg:grid-cols-[1fr_1.6fr] gap-3 items-stretch">
          <AudioDropZone picked={audio} onPick={pickAudioGuarded} />
          <VideoDropList picks={videos} onAdd={pickVideosGuarded} onRemove={removeVideo} />
        </div>
        {usesHandles && (
          <p className="font-mono text-[10px] text-ink-3 tracking-label uppercase">
            ●︎ Files stay where you keep them — no copy into browser storage
          </p>
        )}

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

        <div className="border-t border-rule pt-5 mt-2 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <ReadinessStatus audio={audio} videos={videos} busy={busy} />
            <span className="font-mono text-[10px] tracking-label uppercase text-ink-3 hidden sm:inline">
              03 · Routing
            </span>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <ModeCard
              tag="03A · DIRECT"
              headline={
                <>
                  Have a track.
                  <br />
                  Want a video.
                </>
              }
              path={
                <>
                  <span className="text-ink-3">●━━━━━━▶</span>{" "}
                  <span className="text-ink-2 group-hover:text-hot transition-colors">EDITOR</span>
                </>
              }
              onClick={() => handleSubmit("direct")}
              disabled={!ready}
              busy={busy}
            />
            <ModeCard
              tag="03B · SESSION"
              headline={
                <>
                  Have an hour.
                  <br />
                  Want a song.
                </>
              }
              path={
                <>
                  <span className="text-ink-3">●━━▶</span>{" "}
                  <span className="text-ink-2 group-hover:text-hot transition-colors">TRIAGE</span>{" "}
                  <span className="text-ink-3">━▶</span>{" "}
                  <span className="text-ink-2 group-hover:text-hot transition-colors">EDITOR</span>
                </>
              }
              onClick={() => handleSubmit("longform")}
              disabled={!ready}
              busy={busy}
            />
          </div>
        </div>
      </form>
    </main>
  );
}

function AudioDropZone({
  picked,
  onPick,
}: {
  picked: PickedAsset | null;
  onPick: () => void;
}) {
  const filled = picked !== null;
  return (
    <button
      type="button"
      id="picker-audio"
      onClick={onPick}
      className={[
        "relative block rounded-lg cursor-pointer transition-colors group text-left w-full",
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
                {picked!.file.name}
              </div>
              <div className="mt-1 font-mono text-xs text-ink-2 tabular">
                {formatBytes(picked!.file.size)}
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
    </button>
  );
}

function VideoDropList({
  picks,
  onAdd,
  onRemove,
}: {
  picks: PickedAsset[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="rounded-lg border-2 border-dashed border-rule bg-paper-hi p-3 sm:p-4 flex flex-col gap-2 min-h-[220px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-display tracking-label uppercase text-[11px] text-ink-2">
          02 · Video sources
        </span>
        {picks.length > 0 && (
          <span className="font-mono text-[10px] tracking-label uppercase text-hot">
            ● {picks.length} READY
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {picks.map((p, i) => (
          <li
            key={`${p.file.name}-${i}`}
            className="flex items-center gap-3 px-3 h-11 bg-paper-deep border border-rule rounded-md"
          >
            <span className="font-mono text-xs text-ink-3 tabular w-8">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="font-mono text-sm text-ink truncate flex-1">{p.file.name}</span>
            <span className="font-mono text-xs text-ink-3 tabular hidden sm:inline">
              {formatBytes(p.file.size)}
            </span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="font-mono text-[11px] text-ink-3 hover:text-danger uppercase tracking-label"
              aria-label={`Remove ${p.file.name}`}
            >
              remove
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        id="picker-videos"
        onClick={onAdd}
        className={[
          "mt-auto flex items-center justify-center gap-3 h-12 rounded-md cursor-pointer transition-colors",
          "border border-dashed",
          picks.length === 0
            ? "border-rule text-ink-3 bg-transparent hover:border-ink-2 hover:text-ink-2"
            : "border-rule text-ink-2 hover:border-ink-2 hover:text-ink",
        ].join(" ")}
      >
        <span className="text-xl leading-none">+</span>
        <span className="font-mono text-xs tracking-label uppercase">
          {picks.length === 0 ? "Add videos (multi-select ok)" : "Add another"}
        </span>
      </button>
    </div>
  );
}

function ReadinessStatus({
  audio,
  videos,
  busy,
}: {
  audio: PickedAsset | null;
  videos: PickedAsset[];
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

function ModeCard({
  tag,
  headline,
  path,
  onClick,
  disabled,
  busy,
}: {
  tag: string;
  headline: React.ReactNode;
  path: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "group relative block text-left rounded-lg cursor-pointer transition-colors",
        "border-2 min-h-[180px] p-5 pt-4",
        // Sibling family: dashed when not actionable, solid when ready.
        disabled
          ? "border-dashed border-rule bg-paper-hi text-ink-3 cursor-not-allowed"
          : "border-dashed border-rule bg-paper-hi hover:border-solid hover:border-ink shadow-emboss active:shadow-pressed active:translate-y-[1px]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between mb-4">
        <span className="font-display tracking-label uppercase text-[11px] text-ink-2">
          {tag}
        </span>
        {!disabled && (
          <span className="font-mono text-[10px] tracking-label uppercase text-hot">
            {busy ? "● PREP" : "● PRESS"}
          </span>
        )}
      </div>

      <div className="font-display font-semibold text-2xl sm:text-[28px] leading-[1.05] text-ink mb-5">
        {headline}
      </div>

      <div className="font-mono text-[11px] tracking-tight text-ink-2 tabular">
        {path}
      </div>
    </button>
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
