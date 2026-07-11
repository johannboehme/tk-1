/**
 * Shared React glue for job-scoped ping-pong playback (Triage + Arrange).
 *
 * Owns the effects both screens previously duplicated line-for-line:
 *   - resolve the job's master-audio object URL (+ revoke on change)
 *   - apply the URL to both `<audio>` elements, reset readiness
 *   - flip `isReady` on A-side `loadedmetadata`
 *   - build / reuse the PingPongEngine once elements + metadata exist
 *   - resume the AudioContext on play (browser autoplay policy)
 *   - mirror play/pause onto the ACTIVE element
 *   - apply external playhead writes (user seeks) to the active element
 *     and cancel any armed crossfade they invalidate
 *
 * The per-screen walkers (loop / seam / sequence / arrangement) stay in
 * the callers' RAF loops, driving the returned engine. The Editor does
 * NOT use this hook — its URL comes from props and its seek path runs
 * through `seekRequest` + segment-hint rebinding (a different contract),
 * so forcing it in here would be false unification.
 */
import { useEffect, useRef, useState } from "react";
import { clampSeek } from "../../lib/clamp";
import { resolveJobAssetUrl } from "../jobs";
import {
  getOrCreatePingPongEngine,
  type PingPongEngine,
} from "./pingpong-engine";

export function usePingPongTransport<P>(args: {
  aRef: React.RefObject<HTMLAudioElement | null>;
  bRef: React.RefObject<HTMLAudioElement | null>;
  jobId: string | null;
  isPlaying: boolean;
  /** play() on the active element rejected (autoplay policy) — flip the
   *  store's isPlaying back so the UI doesn't show a phantom transport. */
  onPlayRejected: () => void;
  /** Subscribe to external playhead writes (user seeks). Must be
   *  referentially stable (wrap in useCallback); the subscription is
   *  torn down and re-created when it changes. */
  subscribeExternalTime: (cb: (tS: number) => void) => () => void;
}): {
  engineRef: React.RefObject<PingPongEngine<P> | null>;
  isReady: boolean;
} {
  const { aRef, bRef, jobId, isPlaying, subscribeExternalTime } = args;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const engineRef = useRef<PingPongEngine<P> | null>(null);
  const onPlayRejectedRef = useRef(args.onPlayRejected);
  onPlayRejectedRef.current = args.onPlayRejected;

  // Resolve the master-audio URL for the job.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let revokeMe: string | null = null;
    void resolveJobAssetUrl(jobId, "audio").then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revokeMe = url;
      setAudioUrl(url);
    });
    return () => {
      cancelled = true;
      if (revokeMe) URL.revokeObjectURL(revokeMe);
    };
  }, [jobId]);

  // Apply URL to both elements + reset readiness.
  useEffect(() => {
    setIsReady(false);
    if (audioUrl && aRef.current) aRef.current.src = audioUrl;
    if (audioUrl && bRef.current) bRef.current.src = audioUrl;
  }, [audioUrl, aRef, bRef]);

  // Wait for A-side metadata so we know we can build the graph.
  useEffect(() => {
    const a = aRef.current;
    if (!a) return;
    function onLoaded() {
      setIsReady(true);
    }
    a.addEventListener("loadedmetadata", onLoaded);
    if (a.readyState >= 1) onLoaded();
    return () => {
      a.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [aRef, audioUrl]);

  // Build / reuse the engine (per-element cached — StrictMode safe).
  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b || !isReady) return;
    if (engineRef.current) return;
    const res = getOrCreatePingPongEngine<P>(a, b);
    if (res.ok) engineRef.current = res.engine;
  }, [aRef, bRef, isReady]);

  // Resume the AudioContext on the first interaction (autoplay policy).
  useEffect(() => {
    if (!isPlaying) return;
    engineRef.current?.resumeContext();
  }, [isPlaying]);

  // Mirror play/pause onto the active element.
  useEffect(() => {
    const eng = engineRef.current;
    const el = eng ? eng.activeEl : aRef.current;
    if (!el) return;
    if (isPlaying) {
      void el.play().catch(() => onPlayRejectedRef.current());
    } else {
      el.pause();
    }
  }, [isPlaying, aRef]);

  // Honor external seeks. Compare against the active element's clock to
  // avoid feedback loops with the caller's own RAF time broadcast.
  useEffect(() => {
    return subscribeExternalTime((tS) => {
      const eng = engineRef.current;
      const el = eng ? eng.activeEl : aRef.current;
      if (!el) return;
      if (
        Math.abs(el.currentTime - tS) > 0.05 &&
        Number.isFinite(el.duration)
      ) {
        try {
          el.currentTime = clampSeek(tS, el.duration);
        } catch {
          /* ignore */
        }
        eng?.cancelArmed();
      }
    });
  }, [subscribeExternalTime, aRef]);

  return { engineRef, isReady };
}
