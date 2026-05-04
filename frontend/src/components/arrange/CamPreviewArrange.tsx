/**
 * Cam-preview viewfinder for the Arrange page.
 *
 * Shares the seek-to-master-time-minus-syncOffset logic AND the
 * corner-badge cam-picker with Triage's CamPreview. Renders inside an
 * aluminium-bezel viewfinder shell that fits the Arrange "playback
 * cockpit" look — sub-300px wide on desktop, ~80px square on mobile.
 */
import { useEffect, useState } from "react";
import { resolveCamAssetUrl } from "../../local/jobs";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { CamPickerDropdown } from "../CamPickerDropdown";

/** Cam preview viewfinder. Sizes itself: 84×84 below sm, 240×135 above. */
export function CamPreviewArrange() {
  const jobId = useArrangeStore((s) => s.jobId);
  const cams = useArrangeStore((s) => s.cams);
  const selectedCamId = useArrangeStore((s) => s.selectedCamId);
  const setSelectedCamId = useArrangeStore((s) => s.setSelectedCamId);
  const currentTime = useArrangeStore((s) => s.playback.currentTime);
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

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
      try {
        videoEl.currentTime = sourceT;
      } catch {
        /* ignore */
      }
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

  return (
    <div
      // Mobile: square thumb. Desktop: fixed width but height tracks
      // the cockpit LCD next to it (via the section's items-stretch),
      // so the cam stays flush with the LCD even when the LCD grows.
      // object-cover on the video crops the 16:9 source to whatever
      // aspect the box ends up at — minimal crop in practice.
      className="relative shrink-0 rounded-md overflow-hidden border-2 border-rule shadow-emboss w-[84px] h-[84px] sm:w-[240px] sm:h-auto sm:self-stretch sm:min-h-[135px]"
      style={{
        background:
          "linear-gradient(180deg, #1A1816 0%, #0E0D0B 100%)",
      }}
    >
      {videoUrl ? (
        <video
          ref={setVideoEl}
          src={videoUrl}
          className="absolute inset-0 w-full h-full object-cover bg-black"
          muted
          playsInline
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-paper-hi/40 font-mono text-[9px] tracking-label uppercase">
          {cams.length === 0 ? "no cams" : "loading"}
        </div>
      )}
      {/* Same corner-badge dropdown as the Triage preview — top-left
       *  so the cam-color hint is visible against the dark frame. */}
      <CamPickerDropdown
        cams={cams}
        selectedCamId={selectedCamId}
        onSelect={setSelectedCamId}
      />
    </div>
  );
}
