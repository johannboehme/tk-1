/**
 * Output domain — text overlays, the visualizer config, the export
 * spec, and the EditSpec builder that assembles them for the renderer.
 */
import type {
  EditSpec,
  ExportSpec,
  Segment,
  TextOverlay,
  VisualizerConfig,
} from "../../core/types";
import { sliceByArrSegments } from "../../core/arrangement-time";
import type { SliceCreator } from "./state";

// Default preset = "custom" — meaning "derived from the first clip on
// the timeline". The store's auto-init in `setClipDisplayDims` kicks in
// the first time a clip reports its dims and seeds aspect + resolution
// from that clip. Web/Archive/Mobile are opinionated overrides.
export const DEFAULT_EXPORT: ExportSpec = {
  preset: "custom",
  format: "mp4",
  resolution: "source",
  video_codec: "h264",
  audio_codec: "aac",
  video_bitrate_kbps: 3500,
  audio_bitrate_kbps: 128,
  quality: "good",
};

export interface OutputSliceState {
  overlays: TextOverlay[];
  visualizer: VisualizerConfig | null;
  exportSpec: ExportSpec;
}

export interface OutputSliceActions {
  addOverlay(o: TextOverlay): void;
  updateOverlay(idx: number, patch: Partial<TextOverlay>): void;
  removeOverlay(idx: number): void;
  setVisualizer(v: VisualizerConfig | null): void;
  setExport(patch: Partial<ExportSpec>): void;
  buildEditSpec(): EditSpec;
}

export function initialOutputState(): OutputSliceState {
  return {
    overlays: [],
    visualizer: null,
    exportSpec: DEFAULT_EXPORT,
  };
}

export const createOutputSlice: SliceCreator<OutputSliceActions> = (
  set,
  get,
) => ({
  addOverlay(o) {
    set({ overlays: [...get().overlays, o] });
  },
  updateOverlay(idx, patch) {
    set({
      overlays: get().overlays.map((o, i) =>
        i === idx ? { ...o, ...patch } : o,
      ),
    });
  },
  removeOverlay(idx) {
    set({ overlays: get().overlays.filter((_, i) => i !== idx) });
  },

  setVisualizer(v) {
    set({ visualizer: v });
  },
  setExport(patch) {
    set({ exportSpec: { ...get().exportSpec, ...patch } });
  },

  buildEditSpec() {
    const s = get();
    // Master-trim is universal: every job slices its arrangement
    // segments to the trim window. Single-take jobs come in with one
    // segment [0, duration] so the slice collapses to [trim.in, trim.out];
    // long-form jobs slice each chunk at the trim boundaries (chunks
    // entirely outside the trim window drop, chunks partially inside
    // get clipped). Slice ranges keep their original master-time
    // bounds — the renderer reads `segments[i].{in, out}` as
    // master-time slices to extract.
    const slices = sliceByArrSegments(
      s.trim.in,
      s.trim.out,
      s.arrangementSegments,
    );
    const segments = slices.map((sl) => {
      // arrStartS = the slice's position on the FULL arrangement axis.
      // The renderer needs it to resolve pills/cuts/FX at the editor's
      // arr-coordinates after a master-trim removed leading material.
      const out: Segment = {
        in: sl.masterStartS,
        out: sl.masterEndS,
        arrStartS: sl.arrStartS,
      };
      // Pass through audioStartMs / chunkId for any chunk-anchored
      // metadata the renderer might inspect downstream — we don't
      // re-derive it from the slice (the original segment's anchor
      // doesn't move with a trim cut).
      const seg = s.arrangementSegments.find(
        (g) => g.in <= sl.masterStartS && g.out >= sl.masterEndS,
      );
      if (seg?.audioStartMs != null) out.audioStartMs = seg.audioStartMs;
      if (seg?.chunkId != null) out.chunkId = seg.chunkId;
      return out;
    });
    return {
      version: 1,
      segments,
      overlays: s.overlays,
      visualizer: s.visualizer,
      sync_override_ms: s.offset.userOverrideMs,
      export: s.exportSpec,
    };
  },
});
