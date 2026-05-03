/**
 * Cam preview — shows the active cam's video frame at the playhead,
 * with an overlay dropdown for cam selection.
 *
 * Cam-switching: the corner badge (top-left) doubles as the picker.
 * Click it to open a dropdown of all cams; selecting one updates the
 * triage store's `selectedCamId`. Single hidden `<video>` element per
 * active cam — when the user switches the src updates and the new
 * video seeks to the current master-time minus the cam's sync offset.
 *
 * Triage v1: no preload pool, no gapless cam-switch — accept a brief
 * black flash on cam-switch since this is a curation phase.
 */
import { useEffect, useRef, useState } from "react";
import { resolveCamAssetUrl } from "../../local/jobs";
import { useTriageStore } from "../../local/triage/triage-store";

export function CamPreview() {
  const jobId = useTriageStore((s) => s.jobId);
  const selectedCamId = useTriageStore((s) => s.selectedCamId);
  const setSelectedCamId = useTriageStore((s) => s.setSelectedCamId);
  const cams = useTriageStore((s) => s.cams);
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  const camId = cam?.id ?? null;
  const syncOffsetMs = cam
    ? (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0)
    : 0;

  useEffect(() => {
    if (!jobId || !camId) {
      setVideoUrl(null);
      return;
    }
    let cancelled = false;
    let revokeMe: string | null = null;
    void resolveCamAssetUrl(jobId, camId, "video").then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revokeMe = url;
      setVideoUrl(url);
    });
    return () => {
      cancelled = true;
      if (revokeMe) URL.revokeObjectURL(revokeMe);
    };
  }, [jobId, camId]);

  useEffect(() => {
    if (!videoEl) return;
    const sourceT = currentTime - syncOffsetMs / 1000;
    if (sourceT < 0) {
      if (!videoEl.paused) videoEl.pause();
      return;
    }
    if (Math.abs(videoEl.currentTime - sourceT) > 0.05) {
      videoEl.currentTime = sourceT;
    }
  }, [currentTime, syncOffsetMs, videoEl]);

  useEffect(() => {
    if (!videoEl) return;
    if (isPlaying) {
      void videoEl.play().catch(() => undefined);
    } else {
      videoEl.pause();
    }
  }, [isPlaying, videoEl]);

  // Close picker on outside click + on Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPickerOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const camLabel = cam ? cam.id : "no cams";

  return (
    <div className="w-full h-full flex justify-center items-stretch min-h-0">
      <div
        className="relative bg-black rounded-md border border-rule overflow-hidden max-w-full"
        style={{ aspectRatio: "16/9", height: "100%", width: "auto" }}
      >
        {videoUrl ? (
          <video
            ref={setVideoEl}
            src={videoUrl}
            className="absolute inset-0 w-full h-full object-contain bg-black"
            muted
            playsInline
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-paper-hi/50 font-mono text-[11px] tracking-label uppercase">
            {cams.length === 0 ? "no cams" : "loading…"}
          </div>
        )}

        {/* Cam picker — corner badge that opens a dropdown. */}
        <div ref={pickerRef} className="absolute top-2 left-2 z-10">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            disabled={cams.length === 0}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            className={[
              "inline-flex items-center gap-1.5 px-2 py-1 rounded",
              "bg-black/60 backdrop-blur-sm",
              "text-paper-hi font-mono text-[10px] tracking-label uppercase",
              "hover:bg-black/75 transition-colors",
              "disabled:opacity-50",
            ].join(" ")}
            title="Switch cam"
          >
            {cam && (
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: cam.color }}
                aria-hidden
              />
            )}
            <span>{camLabel}</span>
            {cams.length > 1 && (
              <span className="text-paper-hi/60 text-[8px]">▾</span>
            )}
          </button>
          {pickerOpen && cams.length > 0 && (
            <ul
              role="listbox"
              className={[
                "absolute top-full left-0 mt-1 min-w-[160px]",
                "bg-paper-hi/95 backdrop-blur-md border border-rule rounded shadow-panel",
                "py-1 max-h-60 overflow-y-auto",
              ].join(" ")}
            >
              {cams.map((c) => {
                const active = c.id === camId;
                return (
                  <li key={c.id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCamId(c.id);
                        setPickerOpen(false);
                      }}
                      className={[
                        "w-full text-left px-3 py-1.5",
                        "flex items-center gap-2",
                        "font-mono text-[11px] tracking-label uppercase",
                        active ? "bg-hot/15 text-ink" : "text-ink-2 hover:bg-paper-deep",
                      ].join(" ")}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: c.color }}
                        aria-hidden
                      />
                      <span className="truncate">{c.id}</span>
                      {active && (
                        <span className="ml-auto text-hot text-[9px]">●</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
