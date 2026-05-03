/**
 * React hook around `getChunkThumbnailUrl`. Returns the URL plus a
 * "developing" flag for the first ~600 ms after the URL appears so the
 * UI can play a Polaroid develop-in animation.
 */
import { useEffect, useState } from "react";
import { getChunkThumbnailUrl } from "../../local/arrange/chunk-thumbnails";
import type { Chunk, VideoAsset } from "../../storage/jobs-db";

export interface ChunkThumbnailState {
  url: string | null;
  isDeveloping: boolean;
  failed: boolean;
}

const DEVELOP_MS = 800;

export function useChunkThumbnail(
  jobId: string | null,
  cam: VideoAsset | null,
  chunk: Chunk | null,
  enabled: boolean,
): ChunkThumbnailState {
  const [state, setState] = useState<ChunkThumbnailState>({
    url: null,
    isDeveloping: false,
    failed: false,
  });

  useEffect(() => {
    if (!enabled || !jobId || !cam || !chunk) {
      setState({ url: null, isDeveloping: false, failed: false });
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
