/**
 * Triage audio playback — single hidden `<audio>` element driven by the
 * Triage store. Keeps it dead-simple for v1: respects play/pause +
 * loop region, broadcasts `currentTime` to the store every RAF tick.
 *
 * The dual-element gapless loop pattern from the editor is overkill
 * for chunk-curation playback (loop wraps may be audible at the
 * boundary, but the user is reviewing, not listening). We can upgrade
 * later if it bothers anyone.
 */
import { useEffect, useRef } from "react";
import { useTriageStore } from "../../local/triage/triage-store";
import { resolveJobAssetUrl } from "../../local/jobs";

export function TriageAudioMaster() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const jobId = useTriageStore((s) => s.jobId);
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const setPlaying = useTriageStore((s) => s.setPlaying);
  // Loop + currentTime read imperatively in the RAF loop to avoid
  // re-rendering this component on every tick.

  // Resolve audio URL.
  useEffect(() => {
    if (!jobId || !audioRef.current) return;
    let cancelled = false;
    let revokeMe: string | null = null;
    void resolveJobAssetUrl(jobId, "audio").then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revokeMe = url;
      if (audioRef.current && url) {
        audioRef.current.src = url;
      }
    });
    return () => {
      cancelled = true;
      if (revokeMe) URL.revokeObjectURL(revokeMe);
    };
  }, [jobId]);

  // Mirror play/pause.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) {
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  }, [isPlaying, setPlaying]);

  // RAF loop: broadcast currentTime + enforce loop boundaries.
  useEffect(() => {
    function tick() {
      const el = audioRef.current;
      if (!el) {
        rafRef.current = window.requestAnimationFrame(tick);
        return;
      }
      const state = useTriageStore.getState();
      const t = el.currentTime;
      // Loop enforcement: if the playhead wandered past the loop end,
      // jump back to start. A user seek inside the loop region is
      // honored.
      const loop = state.playback.loop;
      if (loop && t >= loop.end) {
        el.currentTime = loop.start;
      } else if (loop && t < loop.start - 0.1) {
        // User seeked before the loop region — assume they want to
        // exit the loop, but clamp into the loop window for now.
        el.currentTime = loop.start;
      } else {
        // Only push to store when changed enough to avoid spurious
        // re-renders from sub-ms float jitter.
        if (Math.abs(state.playback.currentTime - t) > 0.01) {
          state.tickTime(t);
        }
      }
      rafRef.current = window.requestAnimationFrame(tick);
    }
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Honor seek requests by snapping the audio element to the store's
  // currentTime when it changes via store action (vs. via RAF).
  useEffect(() => {
    const unsub = useTriageStore.subscribe((s, prev) => {
      if (
        s.playback.currentTime !== prev.playback.currentTime &&
        Math.abs((audioRef.current?.currentTime ?? 0) - s.playback.currentTime) > 0.05 &&
        audioRef.current
      ) {
        audioRef.current.currentTime = s.playback.currentTime;
      }
    });
    return unsub;
  }, []);

  return (
    <audio
      ref={audioRef}
      preload="auto"
      // Hidden but mounted — drives the master clock for the whole
      // triage page.
      style={{ display: "none" }}
    />
  );
}
