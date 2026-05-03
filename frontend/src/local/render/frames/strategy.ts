/**
 * Tile-strip layout strategy.
 *
 * Pre-frontend the backend used the same adaptive interval (see the
 * removed `app/pipeline/extract.py`): denser tiles for short videos, coarser
 * for long ones, with a hard cap so the strip image stays bounded.
 */

export interface TileStripPlan {
  /** Time-in-source for each tile, in seconds. */
  timestampsS: number[];
  /** Width of one tile in pixels. */
  tileWidth: number;
  /** Height of one tile in pixels (kept constant; equals input opt). */
  tileHeight: number;
}

export interface TileStripPlanOptions {
  durationS: number;
  /** Source video aspect (width / height). Used to derive tileWidth from tileHeight. */
  sourceWidth: number;
  sourceHeight: number;
  /** Tile height in pixels. Default 80 — matches the pre-frontend setup. */
  tileHeight?: number;
  /** Hard upper bound on tile count. Default 100 — keeps decode work
   *  bounded for very long files (a 16-min recording at 100 tiles is
   *  ~9.6 s/tile, still useful for the timeline). */
  maxTiles?: number;
}

/**
 * Pick the sampling interval that mirrors the pre-frontend Python:
 *
 *   ≤ 60s    → every 0.5s   (dense for short clips)
 *   ≤ 600s   → every 1.0s
 *   ≤ 1800s  → every 5.0s
 *   > 1800s  → every 10.0s
 *
 * Then enforce maxTiles by widening the step as needed. The bigger
 * defaults for long files exist because we'd otherwise hit the cap
 * anyway and the wider native step gives us a deterministic floor.
 */
export function planTileStrip(opts: TileStripPlanOptions): TileStripPlan {
  const tileHeight = opts.tileHeight ?? 80;
  const maxTiles = opts.maxTiles ?? 100;
  if (opts.durationS <= 0 || opts.sourceWidth <= 0 || opts.sourceHeight <= 0) {
    return { timestampsS: [], tileWidth: tileHeight, tileHeight };
  }

  let step: number;
  if (opts.durationS <= 60) step = 0.5;
  else if (opts.durationS <= 600) step = 1.0;
  else if (opts.durationS <= 1800) step = 5.0;
  else step = 10.0;

  let count = Math.max(1, Math.floor(opts.durationS / step));
  if (count > maxTiles) {
    count = maxTiles;
    step = opts.durationS / count;
  }

  // Sample at the *centre* of each interval — visually tracks the strip
  // better than sampling at boundaries (a tile labelled "the 3rd second"
  // shows what played around 2.5s, not the 0.0s keyframe).
  const timestampsS = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    timestampsS[i] = (i + 0.5) * step;
  }

  // Derive tile width from source aspect, keep it even (image codecs prefer
  // even dims) and at least 16 px.
  const aspect = opts.sourceWidth / opts.sourceHeight;
  const rawWidth = Math.round(tileHeight * aspect);
  const tileWidth = Math.max(16, rawWidth - (rawWidth % 2));

  return { timestampsS, tileWidth, tileHeight };
}
