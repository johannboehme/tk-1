/**
 * React hook around `getChunkThumbnailUrl`. Returns the URL plus a
 * "developing" flag for the first ~600 ms after the URL appears so
 * the UI can play a Polaroid develop-in animation.
 *
 * Cache hits short-circuit: if `peekChunkThumbnailUrl` returns a URL
 * synchronously (memory cache populated by the page-mount IDB
 * prefetch), the initial render shows the image WITHOUT the
 * develop-in pulse — only first-time extractions (real async work)
 * play the animation.
 */
import { useEffect, useState } from "react";
import {
  getChunkThumbnailUrl,
  peekChunkThumbnailUrl,
} from "../../local/arrange/chunk-thumbnails";
import type { Chunk, VideoAsset } from "../../storage/jobs-db";

export interface ChunkThumbnailState {
  url: string | null;
  isDeveloping: boolean;
  failed: boolean;
}

const DEVELOP_MS = 800;

function peek(
  jobId: string | null,
  cam: VideoAsset | null,
  chunk: Chunk | null,
  enabled: boolean,
): string | null {
  if (!enabled || !jobId || !cam || !chunk) return null;
  return peekChunkThumbnailUrl(jobId, cam.id, chunk.id);
}

export function useChunkThumbnail(
  jobId: string | null,
  cam: VideoAsset | null,
  chunk: Chunk | null,
  enabled: boolean,
): ChunkThumbnailState {
  // Initialise with whatever's already in the in-memory cache so the
  // first paint of a returning visitor shows the image instantly,
  // bypassing the develop-in pulse.
  const [state, setState] = useState<ChunkThumbnailState>(() => {
    const cached = peek(jobId, cam, chunk, enabled);
    return {
      url: cached,
      isDeveloping: false,
      failed: false,
    };
  });

  useEffect(() => {
    if (!enabled || !jobId || !cam || !chunk) {
      setState({ url: null, isDeveloping: false, failed: false });
      return;
    }
    // Re-check the cache on every effect run — a sibling Polaroid
    // could have just resolved this URL while we were unmounted.
    const cached = peek(jobId, cam, chunk, enabled);
    if (cached) {
      setState({ url: cached, isDeveloping: false, failed: false });
      return;
    }

    let cancelled = false;
    let developTimer: number | null = null;
    setState({ url: null, isDeveloping: false, failed: false });
    void getChunkThumbnailUrl({ jobId, cam, chunk })
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          setState({ url: null, isDeveloping: false, failed: true });
          return;
        }
        setState({ url, isDeveloping: true, failed: false });
        developTimer = window.setTimeout(() => {
          setState((s) => ({ ...s, isDeveloping: false }));
        }, DEVELOP_MS);
      })
      .catch(() => {
        if (cancelled) return;
        setState({ url: null, isDeveloping: false, failed: true });
      });

    return () => {
      cancelled = true;
      if (developTimer !== null) window.clearTimeout(developTimer);
    };
  }, [jobId, cam, chunk, enabled]);

  return state;
}
