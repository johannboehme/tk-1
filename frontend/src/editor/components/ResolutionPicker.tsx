// Resolution picker — long-side presets driven by the active AspectRatio.
//
// V2 split: Aspect lives in `AspectPicker`; this component owns only the
// pixel size of the long side. When the aspect changes, the picker
// derives `{w, h}` via `deriveResolution` and pushes a single resolution
// update to the parent. Custom W/H inputs let the user step outside the
// preset grid; doing so flips the parent into `aspectRatio: "custom"`.

import { useEffect, useState } from "react";
import {
  RESOLUTION_LONG_SIDE_PRESETS,
  deriveResolution,
} from "../exportPresets";
import type { AspectRatio } from "../types";

interface Props {
  /** Active aspect, drives long-side → {w,h} derivation. `"custom"` =
   *  user uses the W/H inputs directly. */
  aspect: AspectRatio | undefined;
  /** Concrete current dims. The source of truth. */
  value: { w: number; h: number };
  /** User picked a preset long-side: parent should re-derive {w,h}
   *  from `aspect` × `longSide` and store both. */
  onPickLongSide: (longSide: number) => void;
  /** User typed concrete dims — parent must flip aspect to "custom". */
  onCustomDims: (dims: { w: number; h: number }) => void;
}

const PRESET_LABELS: Record<number, string> = {
  3840: "4K",
  2560: "1440",
  1920: "1080",
  1280: "720",
  854: "480",
};

function presetLabel(longSide: number): string {
  return PRESET_LABELS[longSide] ?? String(longSide);
}

function roundEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

export function ResolutionPicker({
  aspect,
  value,
  onPickLongSide,
  onCustomDims,
}: Props) {
  const [wInput, setWInput] = useState(String(value.w));
  const [hInput, setHInput] = useState(String(value.h));
  const [aspectLock, setAspectLock] = useState(true);

  // Mirror parent updates into the inputs (preset clicks / aspect flips).
  useEffect(() => {
    setWInput(String(value.w));
    setHInput(String(value.h));
  }, [value.w, value.h]);

  // Aspect-locked typing: derive the other dim from the typed one
  // using the CURRENT value's aspect — that keeps the user's
  // free-form ratio intact even when AspectRatio is "custom".
  const ratio = value.h === 0 ? 1 : value.w / value.h;
  const activeLong = Math.max(value.w, value.h);

  function commitW(raw: string) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 16) return;
    const w = roundEven(n);
    const h = aspectLock ? roundEven(w / ratio) : value.h;
    onCustomDims({ w, h });
  }

  function commitH(raw: string) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 16) return;
    const h = roundEven(n);
    const w = aspectLock ? roundEven(h * ratio) : value.w;
    onCustomDims({ w, h });
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="label">Resolution</span>
      <div className="flex gap-1 flex-wrap">
        {RESOLUTION_LONG_SIDE_PRESETS.map((longSide) => {
          // When aspect is custom, no preset can be "active" — the
          // picker is purely for the W/H inputs in that mode.
          const previewDims =
            aspect && aspect !== "custom"
              ? deriveResolution(aspect, longSide)
              : null;
          const active =
            previewDims != null &&
            previewDims.w === value.w &&
            previewDims.h === value.h;
          const disabled = aspect === "custom" || !aspect;
          return (
            <button
              key={longSide}
              type="button"
              disabled={disabled}
              onClick={() => onPickLongSide(longSide)}
              className={[
                "h-8 px-2.5 rounded-md text-[11px] font-display tracking-label uppercase border",
                active
                  ? "bg-ink text-paper-hi shadow-emboss border-rule/60"
                  : disabled
                  ? "bg-paper-deep text-ink-3 border-rule opacity-50 cursor-not-allowed"
                  : "bg-paper-hi text-ink-2 border-rule hover:bg-paper-deep",
              ].join(" ")}
              title={
                previewDims
                  ? `${previewDims.w} × ${previewDims.h}`
                  : `${longSide}px long side`
              }
            >
              {presetLabel(longSide)}
            </button>
          );
        })}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <span className="text-[10px] font-mono tracking-label uppercase text-ink-3">
            Width
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={16}
            value={wInput}
            onChange={(e) => setWInput(e.target.value)}
            onBlur={() => commitW(wInput)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full min-w-0 bg-paper-hi border border-rule rounded-md h-9 px-2 font-mono text-sm tabular text-right"
          />
        </div>
        <button
          type="button"
          aria-label={aspectLock ? "Aspect locked" : "Aspect free"}
          onClick={() => setAspectLock((v) => !v)}
          className={[
            "h-9 w-9 shrink-0 rounded-md border flex items-center justify-center text-base mb-0",
            aspectLock
              ? "bg-paper-hi border-rule text-hot shadow-emboss"
              : "bg-paper-deep border-rule text-ink-3 shadow-pressed",
          ].join(" ")}
        >
          {aspectLock ? "🔒" : "🔓"}
        </button>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <span className="text-[10px] font-mono tracking-label uppercase text-ink-3">
            Height
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={16}
            value={hInput}
            onChange={(e) => setHInput(e.target.value)}
            onBlur={() => commitH(hInput)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full min-w-0 bg-paper-hi border border-rule rounded-md h-9 px-2 font-mono text-sm tabular text-right"
          />
        </div>
      </div>
      {/* Long-side hint — explains why "1080" might mean 1920×1080 OR
       *  1080×1920, depending on the aspect setting above. */}
      {aspect && aspect !== "custom" && (
        <span className="text-[10px] font-mono tracking-label uppercase text-ink-3">
          Long-side · {activeLong}px
        </span>
      )}
    </div>
  );
}
