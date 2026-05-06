/**
 * Pure builder: store snapshot + master-time → `FrameDescriptor`.
 *
 * Used by:
 *   - `PreviewRuntime` on every RAF tick to drive the backend.
 *   - Tests, which can call this without a Zustand store / React tree.
 *   - Export-side wrapper (Schritt 8) which re-uses the layer/fx logic
 *     but supplies its own intrinsic-rotation map for source frames.
 *
 * No side effects, no DOM access. Returns a fresh descriptor on every
 * call — caller decides about diffing.
 */
import type { Clip, ExportSpec, Pill, Segment } from "../types";
import { isImageClip, normaliseRotation } from "../types";
import type { Cut } from "../../storage/jobs-db";
import type { FxKind, PunchFx } from "../fx/types";
import { activeCamAtArr } from "../arrangement-pills";
import { masterToArr } from "../arrangement-time";
import { activeFxAt } from "../fx/active";
import { fxCatalog } from "../fx/catalog";
import { envelopeAt, INSTANT_ENVELOPE, type ADSREnvelope } from "../fx/envelope";
import { resolveOutputDims } from "../output-frame";
import {
  buildElementFitRect,
  DEFAULT_VIEWPORT_TRANSFORM,
} from "./element-transform";
import type {
  FitRect,
  FrameDescriptor,
  FrameFx,
  FrameLayer,
  OutputDims,
} from "./frame-descriptor";

/** Mirror of the FxHoldEntry shape from the store. Replicated locally
 *  so the descriptor builder stays free of cross-imports back into the
 *  Zustand slice. */
export interface FxHoldSnapshot {
  mode: "persistent" | "preview";
  kind: FxKind;
  fxId: string;
  startS: number;
}

/** Minimal store-snapshot shape the builder needs. Lets tests construct
 *  inputs without instantiating the full Zustand store. */
export interface EditorStoreSnapshot {
  clips: readonly Clip[];
  cuts: readonly Cut[];
  fx: readonly PunchFx[];
  exportSpec: ExportSpec;
  /** Optional. When non-empty (alongside non-empty `arrangementSegments`)
   *  the descriptor builder dispatches each preview frame's active cam
   *  through `activeCamAtArr` so per-pill source-trim is honoured. */
  pills?: readonly Pill[];
  /** Optional. Required for pill-aware rendering — the audio walker's
   *  segment list governs the master↔arr mapping. */
  arrangementSegments?: readonly Segment[];
  /** Active live holds keyed by slot — `mode: "preview"` entries are
   *  synthesised into transient FrameFx (no timeline write). Optional so
   *  test stubs and the export compositor can omit it. */
  fxHolds?: Readonly<Record<string, FxHoldSnapshot>>;
  /** The kind currently bound to the panel's encoders. While set, any
   *  active fx of this kind has its `params`/`envelope` overridden with
   *  the live encoder + ADSR-editor values, so encoder turns reflect in
   *  the preview without re-recording. Optional. */
  selectedFxKind?: FxKind | null;
  /** Per-kind live encoder values (storage-range). When `selectedFxKind`
   *  matches an active fx, this map provides the override params. */
  fxDefaults?: Readonly<Partial<Record<FxKind, Record<string, number>>>>;
  /** Per-kind live ADSR envelope values. Same override scope as
   *  fxDefaults — only the selected kind's envelope is overridden. */
  fxEnvelopes?: Readonly<Partial<Record<FxKind, ADSREnvelope>>>;
}

/**
 * Build a descriptor for the LIVE PREVIEW.
 *
 * Source assumption: `<video>` elements supplied at draw time have the
 * intrinsic MP4 rotation matrix already applied by the browser (i.e.
 * `videoWidth/Height` already swapped). So `rotationDeg` here is the
 * USER rotation only. The export builder (Schritt 8) takes a different
 * code path that adds the intrinsic on top.
 *
 * Time arguments:
 *   - `tMaster` is the master-audio source-time. FX queries still anchor
 *     here because `PunchFx.inS/outS` are master-time in the V1 schema.
 *     A subsequent commit moves FX to timeline-time and drops the dual
 *     argument.
 *   - `tTimeline` is the walker's authoritative timeline-position. Pill
 *     resolution AND source-time computation use this directly: when the
 *     same chunk repeats in the song, master-time alone can't tell the
 *     occurrences apart, so the renderer picks a deterministic-but-wrong
 *     pill. Threading `tTimeline` through preserves the pill identity the
 *     walker already knows.
 */
export function buildPreviewFrameDescriptor(
  snapshot: EditorStoreSnapshot,
  tMaster: number,
  tTimeline?: number,
): FrameDescriptor {
  const output = computeOutputSnapped(snapshot.clips, snapshot.exportSpec.resolution);
  const fxOut = buildFx(snapshot, tMaster);

  if (!output) {
    return { tMaster, output: null, layers: [], fx: fxOut };
  }

  // Active-cam resolution: pill resolution lives in timeline-time. When
  // the caller didn't pass `tTimeline` (test stubs, legacy callers) we
  // fall back to projecting `tMaster` — correct for non-duplicate jobs,
  // wrong for chunks repeated in the song (picks the FIRST occurrence,
  // shows pill 1 where pill 3 should be). New runtime always supplies it.
  const segments = snapshot.arrangementSegments ?? [];
  const pills = snapshot.pills ?? [];
  const tArr = tTimeline ?? masterToArr(tMaster, segments);
  const active = activeCamAtArr(snapshot.cuts, tArr, pills, segments);
  let layers: FrameLayer[] = [];
  if (active) {
    layers = buildPreviewLayersFromPill(
      snapshot.clips,
      active.camId,
      active.pill,
      tArr,
      output,
    );
  }

  return { tMaster, output, layers, fx: fxOut };
}

// ---------- internals ----------

function computeOutputSnapped(
  clips: readonly Clip[],
  resolution: ExportSpec["resolution"],
): OutputDims | null {
  const raw = resolveOutputDims(clips, resolution);
  if (!raw) return null;
  return { w: Math.round(raw.w), h: Math.round(raw.h) };
}

/** Build preview layers from the active pill. The pill's `sourceIn/Out`
 *  is the authoritative source-time mapping (user-edited via the
 *  Timeline's pill-trim handles), so we read it directly and ignore
 *  the cam's master-time anchor. */
function buildPreviewLayersFromPill(
  clips: readonly Clip[],
  activeId: string,
  pill: Pill,
  tArr: number,
  output: OutputDims,
): FrameLayer[] {
  const clip = clips.find((c) => c.id === activeId);
  if (!clip) return [];
  const userRot = normaliseRotation(clip.rotation);
  const flipX = !!clip.flipX;
  const flipY = !!clip.flipY;
  const baseW = clip.displayW ?? 0;
  const baseH = clip.displayH ?? 0;
  if (baseW <= 0 || baseH <= 0) return [];
  const swap = userRot === 90 || userRot === 270;
  const dispW = swap ? baseH : baseW;
  const dispH = swap ? baseW : baseH;
  const fitRect: FitRect = buildElementFitRect(
    { w: dispW, h: dispH },
    { w: output.w, h: output.h },
    clip.viewportTransform ?? DEFAULT_VIEWPORT_TRANSFORM,
  );
  // Linear interpolation between the pill's source endpoints. Bakes any
  // driftRatio into the pill's `sourceOutS - sourceInS` span, which is
  // wider/narrower than `arrEndS - arrStartS` whenever drift ≠ 1. A
  // naive `sourceIn + (tArr - arrStart)` would silently ignore drift and
  // produce wrong source frames on a drifted cam.
  const arrSpan = pill.arrEndS - pill.arrStartS;
  const sourceTimeS =
    arrSpan > 0
      ? pill.sourceInS +
        ((tArr - pill.arrStartS) * (pill.sourceOutS - pill.sourceInS)) /
          arrSpan
      : pill.sourceInS;
  const source = isImageClip(clip)
    ? { kind: "image" as const, clipId: clip.id }
    : {
        kind: "video" as const,
        clipId: clip.id,
        sourceTimeS,
        sourceDurS: clip.sourceDurationS,
      };
  return [
    {
      layerId: clip.id,
      source,
      weight: 1,
      fitRect,
      rotationDeg: userRot,
      flipX,
      flipY,
      displayW: dispW,
      displayH: dispH,
    },
  ];
}

function buildFx(
  snapshot: EditorStoreSnapshot,
  tMaster: number,
): FrameFx[] {
  const out: FrameFx[] = [];
  const selectedKind = snapshot.selectedFxKind ?? null;
  const overrideParams =
    selectedKind != null ? snapshot.fxDefaults?.[selectedKind] : undefined;
  const overrideEnv =
    selectedKind != null ? snapshot.fxEnvelopes?.[selectedKind] : undefined;
  const hasParamOverride = !!(
    overrideParams && Object.keys(overrideParams).length > 0
  );

  // Currently-held PunchFx ids (persistent holds only — preview holds
  // have no fxId). While held, envelope sampling skips the release phase
  // so the effect sits at sustain level until the user lets go (synth-
  // voice semantics). Without this the live-extended `outS` keeps the
  // sample point inside the release window for the entire hold and the
  // effect renders much weaker than its sustain level.
  const heldIds = new Set<string>();
  if (snapshot.fxHolds) {
    for (const h of Object.values(snapshot.fxHolds)) {
      if (h.mode === "persistent" && h.fxId) heldIds.add(h.fxId);
    }
  }

  // Persistent: real PunchFx capsules on the timeline. ADSR-sampled.
  for (const f of activeFxAt(snapshot.fx, tMaster)) {
    const def = fxCatalog[f.kind];
    const useOverride = selectedKind === f.kind;
    const baseParams = f.params ?? {};
    const merged: Record<string, number> = {
      ...def.defaultParams,
      ...(useOverride && hasParamOverride ? overrideParams : baseParams),
    };
    const env =
      (useOverride ? overrideEnv : undefined) ??
      f.envelope ??
      INSTANT_ENVELOPE;
    const holding = heldIds.has(f.id);
    const wetness = envelopeAt(env, f.outS - f.inS, tMaster - f.inS, holding);
    if (wetness <= 0) continue;
    // Per-kind wetness application — each effect knows how to dim
    // itself intelligently. Generic alpha-blend over source doesn't
    // work for displacement effects (zoom would ghost), so the kinds
    // ship their own scaling in `def.applyWetness`.
    const params =
      def.applyWetness && wetness < 1
        ? def.applyWetness(merged, wetness)
        : merged;
    out.push({
      id: f.id,
      kind: f.kind,
      inS: f.inS,
      params,
      wetness,
    });
  }

  // Preview holds: while playback is paused, pad-presses overlay the
  // effect at full strength on the live frame without writing anything
  // to fx[]. Synthesised here as transient FrameFx with wetness=1 so the
  // user can dial DEPTH/EDGE with full visual feedback.
  if (snapshot.fxHolds) {
    for (const hold of Object.values(snapshot.fxHolds)) {
      if (hold.mode !== "preview") continue;
      const def = fxCatalog[hold.kind];
      if (!def) continue;
      const live = snapshot.fxDefaults?.[hold.kind];
      const params: Record<string, number> = {
        ...def.defaultParams,
        ...(live ?? {}),
      };
      out.push({
        id: `preview:${hold.kind}:${hold.fxId || hold.startS}`,
        kind: hold.kind,
        inS: hold.startS,
        params,
        wetness: 1,
      });
    }
  }

  return out;
}

// `buildElementFitRect` lives in `./element-transform` — re-exported there
// so both preview (this file) and export (`local/render/compositor.ts`)
// hit the same implementation. Don't add a second copy here.
export { buildElementFitRect } from "./element-transform";
