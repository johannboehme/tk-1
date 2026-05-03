/**
 * Cam-preview viewfinder for the Arrange page.
 *
 * Shares the seek-to-master-time-minus-syncOffset logic with Triage's
 * CamPreview, but renders inside an aluminium-bezel viewfinder shell
 * that fits the Arrange "playback cockpit" look. Sub-300px wide on
 * desktop, ~80px square on mobile (compact mode).
 */
import { useEffect, useState } from "react";
import { resolveCamAssetUrl } from "../../local/jobs";
import { useArrangeStore } from "../../local/arrange/arrange-store";

interface Props {
  compact?: boolean;
}

export function CamPreviewArrange({ compact = false }: Props) {
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

  // Compact (mobile): a square 84×84 thumbnail viewfinder. Desktop:
  // 16:9 ~240×135.
  const dims = compact
    ? { className: "w-[84px] h-[84px]", aspect: undefined }
    : { className: "w-[240px] h-[135px]", aspect: undefined };

  return (
    <div
      className={`relative shrink-0 rounded-md overflow-hidden border-2 border-rule shadow-emboss ${dims.className}`}
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
      {/* Cam-name + picker pill at the bottom */}
      {cam && cams.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 px-1.5 py-1 flex items-center gap-1 bg-black/60 backdrop-blur-sm">
          {cams.length > 1 && (
            <button
              type="button"
              onClick={() => cycleCam(cams, cam.id, setSelectedCamId, -1)}
              className="text-paper-hi/80 hover:text-paper-hi font-mono text-[10px] leading-none px-1"
              aria-label="Previous cam"
            >
              ◀
            </button>
          )}
          <span
            className="flex-1 inline-flex items-center gap-1 font-mono text-[9px] tracking-label uppercase text-paper-hi/90 leading-none"
          >
            <span
              aria-hidden
              className="block w-1.5 h-1.5 rounded-full"
              style={{ background: cam.color }}
            />
            {cam.id}
          </span>
          {cams.length > 1 && (
            <button
              type="button"
              onClick={() => cycleCam(cams, cam.id, setSelectedCamId, 1)}
              className="text-paper-hi/80 hover:text-paper-hi font-mono text-[10px] leading-none px-1"
              aria-label="Next cam"
            >
              ▶
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function cycleCam(
  cams: Array<{ id: string }>,
  currentId: string,
  setSelectedCamId: (id: string | null) => void,
  delta: number,
) {
  const idx = cams.findIndex((c) => c.id === currentId);
  if (idx === -1) return;
  const next = (idx + delta + cams.length) % cams.length;
  setSelectedCamId(cams[next].id);
}
