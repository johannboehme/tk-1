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
import { CamPickerDropdown } from "../CamPickerDropdown";
import { decideCamPreviewAction } from "../../local/timing/cam-preview-sync";

export function CamPreview() {
  const jobId = useTriageStore((s) => s.jobId);
  const selectedCamId = useTriageStore((s) => s.selectedCamId);
  const setSelectedCamId = useTriageStore((s) => s.setSelectedCamId);
  const cams = useTriageStore((s) => s.cams);
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  const camId = cam?.id ?? null;
  const syncOffsetMs = cam
    ? (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0)
    : 0;
  const driftRatio = cam?.sync?.driftRatio ?? 1;
  const sourceDurationS = cam?.durationS ?? null;

  // Tracks the previous `masterT` so the per-tick decider can tell
  // natural ~16 ms RAF advance apart from a meaningful jump (chunk
  // click / scrub / loop wrap). Reset whenever the active cam changes
  // so the next tick re-snaps to the new element.
  const prevMasterTRef = useRef<number | null>(null);
  useEffect(() => {
    prevMasterTRef.current = null;
  }, [camId]);

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
    // Skip while the element is still recovering from a previous seek.
    // Stacking another `currentTime = X` on top of an in-flight seek
    // tears the decoder open mid-flight on huge phone recordings —
    // exactly the post-seek stutter loop the user reports.
    if (videoEl.seeking) {
      // Don't update prevMasterT — we want the NEXT non-seeking tick to
      // see the full delta from before the seek so it can classify it
      // as a jump.
      return;
    }
    const action = decideCamPreviewAction({
      masterT: currentTime,
      syncOffsetMs,
      sourceDurationS,
      driftRatio,
      videoCurrentTimeS: Number.isFinite(videoEl.currentTime)
        ? videoEl.currentTime
        : null,
      prevMasterT: prevMasterTRef.current,
    });
    prevMasterTRef.current = currentTime;

    if (action.kind === "pause-before-start") {
      if (!videoEl.paused) videoEl.pause();
      return;
    }
    if (action.kind === "seek") {
      videoEl.currentTime = action.sourceT;
    }
    if (action.kind === "pause-after-end") {
      if (!videoEl.paused) videoEl.pause();
      return;
    }
    // Cam IS visible. If the master is playing but our element is paused
    // (e.g. we just crossed sourceT=0 after a `pause-before-start`
    // window), resume — without this, the preview stays frozen on the
    // first post-anchor frame even though the master plays on.
    if (isPlaying && videoEl.paused) {
      void videoEl.play().catch(() => undefined);
    }
  }, [currentTime, syncOffsetMs, driftRatio, sourceDurationS, isPlaying, videoEl]);

  useEffect(() => {
    if (!videoEl) return;
    if (isPlaying) {
      void videoEl.play().catch(() => undefined);
    } else {
      videoEl.pause();
    }
  }, [isPlaying, videoEl]);

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

        <CamPickerDropdown
          cams={cams}
          selectedCamId={selectedCamId}
          onSelect={setSelectedCamId}
        />
      </div>
    </div>
  );
}
