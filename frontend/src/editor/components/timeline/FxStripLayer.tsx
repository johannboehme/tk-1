/**
 * FX-Capsule-Layer für die ProgramStrip — Tonband-Visual.
 *
 * Konzept:
 *   - Eine durchgängige Tape-Lane, die in horizontale Segmente unterteilt
 *     ist. Jedes Segment kennt die Menge der dort aktiven FX-Kinds.
 *   - Slot-Höhe ist DYNAMISCH pro Segment: nur die in diesem Segment
 *     aktiven FX teilen sich die Höhe (1/k bei k aktiven). Frei wenn
 *     gar nichts läuft. Reihenfolge der aktiven Slots = catalog-Order.
 *   - Live-Recording-Edge ist ein dünner heller Pulser am outS der
 *     liveFxIds, vertikal beschränkt auf den Slot des Live-Kinds an
 *     dieser Stelle.
 *
 * Read-only — keine Pointer-Events, keine Drag/Resize, keine ×-Buttons.
 * Editieren passiert ausschließlich über Hotkeys + Pad-Buttons.
 */
import { useMemo } from "react";
import type { FxKind, PunchFx } from "../../../core/fx/types";
import { fxCatalog } from "../../../core/fx/catalog";

interface Props {
  fx: readonly PunchFx[];
  viewStartS: number;
  viewEndS: number;
  width: number;
  height: number;
  liveFxIds: ReadonlySet<string>;
}

interface Segment {
  startS: number;
  endS: number;
  /** True per slot index (catalog order). */
  active: boolean[];
}

export function FxStripLayer({
  fx,
  viewStartS,
  viewEndS,
  width,
  height,
  liveFxIds,
}: Props) {
  // Stable slot order — fxCatalog object insertion order.
  const slots = useMemo<FxKind[]>(
    () => Object.keys(fxCatalog) as FxKind[],
    [],
  );
  const slotIndexOf = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    slots.forEach((k, i) => {
      m[k] = i;
    });
    return m;
  }, [slots]);
  const N = slots.length;

  const visibleSpan = Math.max(1e-6, viewEndS - viewStartS);
  const tToX = (t: number) =>
    ((t - viewStartS) / visibleSpan) * width;

  const segments = useMemo<Segment[]>(() => {
    if (N === 0) return [];
    const lo = viewStartS;
    const hi = viewEndS;
    const ts = new Set<number>([lo, hi]);
    for (const f of fx) {
      if (f.outS <= lo || f.inS >= hi) continue;
      ts.add(Math.max(lo, Math.min(hi, f.inS)));
      ts.add(Math.max(lo, Math.min(hi, f.outS)));
    }
    const sorted = [...ts].filter((t) => t >= lo && t <= hi).sort((a, b) => a - b);
    const out: Segment[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b - a < 1e-9) continue;
      const mid = (a + b) / 2;
      const active = new Array<boolean>(N).fill(false);
      for (const f of fx) {
        if (f.inS <= mid && mid < f.outS) {
          const idx = slotIndexOf[f.kind];
          if (idx != null) active[idx] = true;
        }
      }
      out.push({ startS: a, endS: b, active });
    }
    return out;
  }, [fx, viewStartS, viewEndS, slotIndexOf, N]);

  // Pre-compute the active set for each live-fx outS so the pulser can
  // place itself relative to the dynamic slot layout at that position.
  const livePulses = useMemo(() => {
    const items: Array<{
      slotTopPct: number;
      slotHPct: number;
      outS: number;
      color: string;
    }> = [];
    for (const live of fx) {
      if (!liveFxIds.has(live.id)) continue;
      const probe = live.outS - 1e-6; // tiny step back so [inS, outS) coverage rule holds
      // Build the active set at this exact instant.
      const active = new Array<boolean>(N).fill(false);
      for (const f of fx) {
        if (f.inS <= probe && probe < f.outS) {
          const idx = slotIndexOf[f.kind];
          if (idx != null) active[idx] = true;
        }
      }
      const layout = computeSlotLayout(active);
      const myIdx = slotIndexOf[live.kind];
      const span = layout.find((s) => s.slotIndex === myIdx);
      if (!span) continue;
      items.push({
        slotTopPct: span.topPct,
        slotHPct: span.heightPct,
        outS: live.outS,
        color: fxCatalog[live.kind].capsuleColor,
      });
    }
    return items;
  }, [fx, liveFxIds, slotIndexOf, N]);

  if (N === 0) return null;

  return (
    <div
      className="relative pointer-events-none"
      style={{ width, height, overflow: "hidden" }}
    >
      {segments.map((seg, i) => {
        if (!seg.active.some(Boolean)) return null;
        const x1 = tToX(seg.startS);
        const x2 = tToX(seg.endS);
        if (x2 < 0 || x1 > width) return null;
        const left = Math.max(0, x1);
        const right = Math.min(width, x2);
        if (right <= left) return null;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{
              left,
              width: right - left,
              background: stripeGradient(seg.active, slots),
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(0,0,0,0.4)",
            }}
            title={kindList(seg.active, slots)}
          />
        );
      })}

      {/* Leading-edge pulser per live fx — sits on top of the stripes. */}
      {livePulses.map((p, i) => {
        const x = tToX(p.outS);
        if (x < -2 || x > width + 2) return null;
        const slotTop = (p.slotTopPct / 100) * height;
        const slotH = (p.slotHPct / 100) * height;
        return (
          <span
            key={i}
            className="absolute pointer-events-none"
            style={{
              left: x - 1,
              top: slotTop,
              width: 2,
              height: slotH,
              background:
                "linear-gradient(180deg, #FFFFFF 0%, rgba(255,255,255,0.7) 100%)",
              boxShadow: `0 0 6px ${p.color}, 0 0 12px rgba(255,255,255,0.85)`,
              animation: "vas-fx-live-pulse 0.7s ease-in-out infinite",
            }}
          />
        );
      })}
    </div>
  );
}

/** Compute the dynamic slot layout for one segment: only the active
 *  slots share the lane height, in catalog order. With k actives each
 *  gets 100/k of the height, starting at the top. Returns one entry per
 *  active slot, in vertical order. */
function computeSlotLayout(active: boolean[]): Array<{
  slotIndex: number;
  topPct: number;
  heightPct: number;
}> {
  const k = active.reduce((n, on) => n + (on ? 1 : 0), 0);
  if (k === 0) return [];
  const each = 100 / k;
  const out: Array<{ slotIndex: number; topPct: number; heightPct: number }> = [];
  let written = 0;
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue;
    out.push({
      slotIndex: i,
      topPct: written * each,
      heightPct: each,
    });
    written++;
  }
  return out;
}

/** Build a vertical multi-stop linear-gradient that paints ONLY the
 *  active slots in their catalog colour, sharing the lane height equally
 *  among them. Inactive slots don't take any space — with 1 fx active
 *  the colour fills the full lane height, with 2 each takes half, etc. */
function stripeGradient(active: boolean[], slots: FxKind[]): string {
  const layout = computeSlotLayout(active);
  if (layout.length === 0) return "transparent";
  const stops: string[] = [];
  for (const span of layout) {
    const color = fxCatalog[slots[span.slotIndex]].capsuleColor;
    const startPct = span.topPct;
    const endPct = span.topPct + span.heightPct;
    stops.push(`${color} ${startPct.toFixed(3)}% ${endPct.toFixed(3)}%`);
  }
  return `linear-gradient(180deg, ${stops.join(", ")})`;
}

function kindList(active: boolean[], slots: FxKind[]): string {
  const labels: string[] = [];
  for (let i = 0; i < active.length; i++) {
    if (active[i]) labels.push(fxCatalog[slots[i]].label);
  }
  return labels.join(" + ");
}

export type FxStripLayerProps = Props;
