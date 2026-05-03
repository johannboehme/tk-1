/**
 * Cam preview — shows the active cam's video frame at the playhead.
 *
 * Single hidden `<video>` element per active cam. When the user
 * switches cams (via SyncPatchPanel row click), the src updates and
 * the new video seeks to the current master-time minus the cam's
 * sync offset. Cheap re-mount because the underlying `<video>` only
 * decodes around the seek point.
 *
 * Triage v1: no preload pool, no gapless cam-switch — accept a brief
 * black flash on cam-switch since this is a curation phase, not
 * production playback.
 */
import { useEffect, useState } from "react";
import { resolveCamAssetUrl } from "../../local/jobs";
import { useTriageStore } from "../../local/triage/triage-store";

export function CamPreview() {
  const jobId = useTriageStore((s) => s.jobId);
  const selectedCamId = useTriageStore((s) => s.selectedCamId);
  const cams = useTriageStore((s) => s.cams);
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  const camId = cam?.id ?? null;
  // Total sync offset = algorithm offset + user override.
  const syncOffsetMs = cam
    ? (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0)
    : 0;

  // Resolve URL when cam changes.
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

  // Seek the video to currentTime - syncOffset whenever the playhead moves.
  useEffect(() => {
    if (!videoEl) return;
    // Source-time = master-time - sync offset.
    const sourceT = currentTime - syncOffsetMs / 1000;
    if (sourceT < 0) {
      // Master is before this cam's first frame — pause and stay at 0.
      if (!videoEl.paused) videoEl.pause();
      return;
    }
    if (Math.abs(videoEl.currentTime - sourceT) > 0.05) {
      videoEl.currentTime = sourceT;
    }
  }, [currentTime, syncOffsetMs, videoEl]);

  // Mirror play/pause state.
  useEffect(() => {
    if (!videoEl) return;
    if (isPlaying) {
      void videoEl.play().catch(() => undefined);
    } else {
      videoEl.pause();
    }
  }, [isPlaying, videoEl]);

  return (
    <div className="relative bg-black rounded-md border border-rule overflow-hidden aspect-video">
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
      {cam && (
        <span
          className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-2 py-1 rounded bg-black/60 text-paper-hi font-mono text-[10px] tracking-label uppercase backdrop-blur-sm"
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: cam.color }}
          />
          {cam.id}
        </span>
      )}
    </div>
  );
}
