/**
 * Punch-in FX domain — the recorded FX capsules, live holds (polyphonic
 * punch-ins), the recording-head (selected kind + per-kind defaults /
 * envelopes / modulations) and the master-loudness envelope that feeds
 * sidechain modulation.
 */
import type { FxKind, PunchFx } from "../../core/fx/types";
import { defaultTapLengthS, fxCatalog } from "../../core/fx/catalog";
import type { ADSREnvelope } from "../../core/fx/envelope";
import { INSTANT_ENVELOPE } from "../../core/fx/envelope";
import {
  DEFAULT_MOD_CONFIG,
  type AudioEnvelope,
  type LfoConfig,
  type ModConfig,
  type Modulation,
  type SidechainConfig,
} from "../../core/fx/modulation";
import type { SliceCreator } from "./state";

/** One live punch-in hold per slot key. The slotKey identifies the trigger
 *  source ("key:F" for hotkey F, "pad:0" for the first hardware pad).
 *  Multiple holds may exist simultaneously — polyphony is intentional and
 *  what makes P-FX feel like a step-sequencer / synth, not a switch. */
export interface FxHoldEntry {
  /** Persistent: hold writes a real PunchFx to fx[] and grows outS while
   *  held — recorded onto the timeline.
   *
   *  Preview: hold renders the effect over the live preview at full
   *  strength (sustain=1, no envelope) BUT does NOT write to fx[]. Used
   *  while playback is paused so the user can audition / tweak params
   *  with both encoders without polluting the timeline with 1-frame
   *  capsules. */
  mode: "persistent" | "preview";
  /** Kind being held. In persistent mode mirrors the new fx's kind; in
   *  preview mode there's no fx so this is the only place the kind lives. */
  kind: FxKind;
  /** ID of the FX whose outS is currently being live-extended. Empty
   *  string for `mode: "preview"` — no fx is written. */
  fxId: string;
  /** Master-time when this hold started (already snapped by the caller). */
  startS: number;
  /** Snapshot of fx[] at hold-start; used by cancel to revert. Empty
   *  array for preview mode (nothing to revert). */
  priorFx: PunchFx[];
}

const FX_MIN_WINDOW_S = 0.05;
/** Buffer pushed past the playhead during a live hold. Keeps `t < outS`
 *  true across RAF jitter and snap-quantization gaps. ~3 frames at 60Hz. */
const FX_HOLD_OVERSHOOT_S = 0.05;
/** Width of the "erase head" punch-through. ~150 ms so a brief X-tap
 *  leaves a clearly visible gap, and consecutive frames of an X-hold at
 *  the same paused playhead don't collapse to a no-op (a 1-frame head
 *  trims the fx by 1 frame on first tick, then the snapped t falls
 *  outside the trimmed fx and nothing else happens). 150 ms is wide
 *  enough to read on the tape strip without obliterating neighbours. */
const FX_ERASE_DELTA_S = 0.15;

/** Apply the tape-overwrite pre-filter to `fx` for a write into
 *  `[rangeStartS, rangeEndS)` of kind `kind`. Live fx (ids in
 *  `liveIds`) are protected and pass through untouched. Any other fx of
 *  the same kind that overlaps the range is trimmed to the part(s)
 *  outside the range; if degenerate (< FX_MIN_WINDOW_S) it's dropped.
 *
 *  Pure helper so we can call it from both beginFxHold (range starts at
 *  startS, end is the default-tap commit) and tickFxHold (range grows
 *  with the playhead). */
function clobberSameKindOverlapping(
  fx: readonly PunchFx[],
  kind: FxKind,
  rangeStartS: number,
  rangeEndS: number,
  liveIds: ReadonlySet<string>,
): readonly PunchFx[] {
  if (rangeEndS <= rangeStartS) return fx;
  // Fast path: scan once, detect whether ANY non-live same-kind fx
  // overlaps the range. If none does, the result is reference-identical
  // to `fx` — we can skip allocating + set()ing entirely. This matters
  // for `tickFxHold`, which calls us at 60 Hz while F is held; the
  // common case (held FX growing into virgin tape) has no overlaps.
  let needsChange = false;
  for (const f of fx) {
    if (f.kind !== kind || liveIds.has(f.id)) continue;
    if (f.outS <= rangeStartS || f.inS >= rangeEndS) continue;
    needsChange = true;
    break;
  }
  if (!needsChange) return fx;
  const out: PunchFx[] = [];
  for (const f of fx) {
    if (f.kind !== kind || liveIds.has(f.id)) {
      out.push(f);
      continue;
    }
    // No overlap → keep.
    if (f.outS <= rangeStartS || f.inS >= rangeEndS) {
      out.push(f);
      continue;
    }
    // Fully inside → drop.
    if (f.inS >= rangeStartS && f.outS <= rangeEndS) {
      continue;
    }
    // Overlaps the front edge: trim back end.
    if (f.inS < rangeStartS && f.outS <= rangeEndS) {
      const trimmed: PunchFx = { ...f, outS: rangeStartS };
      if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) out.push(trimmed);
      continue;
    }
    // Overlaps the back edge: trim front start.
    if (f.inS >= rangeStartS && f.outS > rangeEndS) {
      const trimmed: PunchFx = { ...f, inS: rangeEndS };
      if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) out.push(trimmed);
      continue;
    }
    // Range strictly inside f → split into two pieces.
    const left: PunchFx = { ...f, outS: rangeStartS };
    const right: PunchFx = { ...f, id: makeFxId(), inS: rangeEndS };
    if (left.outS - left.inS >= FX_MIN_WINDOW_S) out.push(left);
    if (right.outS - right.inS >= FX_MIN_WINDOW_S) out.push(right);
  }
  return out;
}

export function makeFxId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fx-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export interface FxSliceState {
  /** Punch-in FX (visual effects with in/out spans, freely overlapping). */
  fx: PunchFx[];
  /** Live punch-in holds keyed by slotKey (e.g. "key:F", "pad:0"). Multiple
   *  may be active simultaneously. Plain object so zustand reference-equality
   *  selectors work cleanly (a Map would mutate-in-place under naive use). */
  fxHolds: Record<string, FxHoldEntry>;
  /** "Recording head" state — which FX kind the FxHardwarePanel's two
   *  encoders + LCD are currently editing. Drücken eines Pads (Tastatur
   *  oder UI) selektiert den Kind; die Werte der Knobs werden in
   *  `fxDefaults` für genau diesen Kind geschrieben. Was schon auf der
   *  Timeline liegt (PunchFx mit gefrozen `params`) bleibt unverändert —
   *  Recording-Head schreibt vorwärts, nicht rückwärts. */
  selectedFxKind: FxKind;
  /** Per-Kind Encoder-Defaults — Storage-Range (z.B. vignette intensity
   *  in 0..1, NICHT die 0..100 Display-Werte). Wenn ein Eintrag fehlt,
   *  fällt `beginFxHold` auf `fxCatalog[kind].defaultParams` zurück.
   *  In-memory only in V1 — Persistenz über jobs.db kommt sobald wir
   *  entscheiden ob das per-Job (Edit) oder global (User-Pref) lebt. */
  fxDefaults: Partial<Record<FxKind, Record<string, number>>>;
  /** Per-Kind ADSR-Hüllkurve — wird beim `beginFxHold` in die neu
   *  geschriebene PunchFx eingefroren, parallel zu `fxDefaults`. Wenn ein
   *  Eintrag fehlt, fällt das Bake auf `fxCatalog[kind].defaultEnvelope`
   *  (oder INSTANT_ENVELOPE) zurück. In-memory only — gleiche Persistenz-
   *  Frage wie fxDefaults. */
  fxEnvelopes: Partial<Record<FxKind, ADSREnvelope>>;
  /** Per-kind modulator config (timeMod + depth + lfo + sidechain) — the
   *  M-screen edits this; baked into new PunchFx at beginFxHold alongside
   *  the envelope. Missing → DEFAULT_MOD_CONFIG (envelope-only). */
  fxModulations: Partial<Record<FxKind, ModConfig>>;
  /** Normalized master-loudness curve (0..1 over master-audio seconds),
   *  computed once from the decoded PCM at load. Drives sidechain
   *  modulation and the sidechain widget's waveform/preview band. null
   *  until the audio is decoded (or if decode failed). */
  audioEnv: AudioEnvelope | null;
}

export interface FxSliceActions {
  /** Insert a fx and return its id. The caller is responsible for snapping
   *  inS/outS — like every other time-mutating action in this store. */
  addFx(kind: FxKind, inS: number, outS: number, params?: Record<string, number>): string;
  /** Move a fx's in-point. Min-window 0.05 s preserved relative to outS. */
  setFxIn(id: string, inS: number): void;
  /** Move a fx's out-point. Min-window 0.05 s preserved relative to inS. */
  setFxOut(id: string, outS: number): void;
  removeFx(id: string): void;
  /** Drop every persisted FX-capsule. Used by the long-press-clear
   *  gesture on the FX strip. Live recordings (`fxHolds`) are left
   *  untouched — `cancelAllFxHolds()` is the right call for those. */
  clearAllFx(): void;
  /** Begin a live punch-in. Creates a fx with default-tap-length and
   *  records a hold under `slotKey`. `startS` should already be snapped. */
  beginFxHold(slotKey: string, kind: FxKind, startS: number): void;
  /** Live-extend the held fx's out-point. Out only grows — going backward
   *  from a previously-extended position keeps the larger value, so a quick
   *  release after a long hold doesn't shrink the capsule. */
  tickFxHold(slotKey: string, currentS: number): void;
  /** Finalise the hold — leaves the fx in place, drops the hold record. */
  endFxHold(slotKey: string): void;
  /** Revert this slot's hold using its priorFx snapshot. */
  cancelFxHold(slotKey: string): void;
  /** Esc: revert every active hold. Iterates in insertion-order, each
   *  revert applied on top of the prior (so the very first priorFx wins). */
  cancelAllFxHolds(): void;
  /** Punch a small "erase head" through any non-live fx whose range
   *  contains `t` (inS <= t < outS). `kinds` filters which kinds to
   *  affect: "all" hits every kind; an array hits only listed kinds.
   *  Splits / trims / drops as needed. Live (currently-held) fx are
   *  never touched here — call endFxHold first if you want to abort
   *  a live recording. */
  eraseFxAt(t: number, kinds: FxKind[] | "all"): void;
  /** Switch which FxKind the panel's encoders are editing. Called from
   *  pad-press handlers (mouse + keyboard) — the recording head moves
   *  with whatever you just punched. */
  setSelectedFxKind(kind: FxKind): void;
  /** Set the encoder default for `paramId` of `kind` (storage-range —
   *  the encoder's display 0..100 is mapped against the param's
   *  min/max in catalog). Called from the encoder's drag handler. */
  setFxDefault(kind: FxKind, paramId: string, value: number): void;
  /** Patch the ADSR envelope default for `kind` — partial update so the
   *  ADSR-Editor can drag a single point without re-sending the whole
   *  envelope. Missing fields keep their prior value. */
  setFxEnvelope(kind: FxKind, partial: Partial<ADSREnvelope>): void;
  /** Reset envelope for `kind` back to the catalog's defaultEnvelope
   *  (or INSTANT_ENVELOPE if none). Used by double-click on ADSR knots. */
  resetFxEnvelope(kind: FxKind): void;
  /** Pick the active time-modulator for a kind (LFO vs sidechain). */
  setFxTimeMod(kind: FxKind, timeMod: "lfo" | "sidechain"): void;
  /** Set how strongly the modulator grabs the intensity (0..1). */
  setFxModDepth(kind: FxKind, depth: number): void;
  /** Patch the kind's LFO config (shape / rate / beatSync). */
  setFxLfo(kind: FxKind, patch: Partial<LfoConfig>): void;
  /** Patch the kind's sidechain config (threshold / attack / release / invert). */
  setFxSidechain(kind: FxKind, patch: Partial<SidechainConfig>): void;
  /** Store the master-loudness curve computed from decoded PCM at load. */
  setAudioEnv(env: AudioEnvelope | null): void;
}

export function initialFxState(): FxSliceState {
  return {
    fx: [],
    fxHolds: {},
    selectedFxKind: "vignette",
    fxDefaults: {},
    fxEnvelopes: {},
    fxModulations: {},
    audioEnv: null,
  };
}

export const createFxSlice: SliceCreator<FxSliceActions> = (set, get) => ({
  addFx(kind, inS, outS, params) {
    const id = makeFxId();
    // Enforce min-window so a tap or quick drag never produces a sliver
    // capsule that the user can't grab again.
    const safeOut = Math.max(outS, inS + FX_MIN_WINDOW_S);
    const fx: PunchFx = params
      ? { id, kind, inS, outS: safeOut, params }
      : { id, kind, inS, outS: safeOut };
    set({ fx: [...get().fx, fx] });
    return id;
  },
  setFxIn(id, inS) {
    const next = get().fx.map((f) => {
      if (f.id !== id) return f;
      // Clamp so inS stays at most outS - min-window. If the user pushes
      // past that, the fx collapses to its minimum width anchored at outS.
      const clampedIn = Math.min(inS, f.outS - FX_MIN_WINDOW_S);
      return { ...f, inS: clampedIn };
    });
    set({ fx: next });
  },
  setFxOut(id, outS) {
    const next = get().fx.map((f) => {
      if (f.id !== id) return f;
      // Symmetric clamp: outS at least inS + min-window.
      const clampedOut = Math.max(outS, f.inS + FX_MIN_WINDOW_S);
      return { ...f, outS: clampedOut };
    });
    set({ fx: next });
  },
  removeFx(id) {
    set({ fx: get().fx.filter((f) => f.id !== id) });
  },
  clearAllFx() {
    // Don't touch live recordings — they're owned by `fxHolds` and
    // need to flow through cancelAllFxHolds() if the caller wants to
    // also abort in-flight punches.
    const liveIds = new Set<string>();
    for (const h of Object.values(get().fxHolds)) liveIds.add(h.fxId);
    set({ fx: get().fx.filter((f) => liveIds.has(f.id)) });
  },
  beginFxHold(slotKey, kind, startS) {
    // Single set() per keypress — cuts subscriber-fanout cost (13 field
    // checks in useAutoPersist alone) by 3-4×. The previous version
    // called set() up to four times: prior-hold cleanup → clobber →
    // addFx → fxHolds update. Each one fired every store subscriber
    // synchronously inside the hot keydown handler.
    const s = get();

    // Audition mode: while playback is paused the pad just overlays
    // the effect on the live frame so the user can dial in DEPTH/EDGE
    // with full visual feedback. NOTHING is written to fx[] — no 1-px
    // capsule on the timeline, no clobber, no priorFx snapshot needed.
    if (!s.playback.isPlaying) {
      const prior = s.fxHolds[slotKey];
      const nextHolds: Record<string, FxHoldEntry> = { ...s.fxHolds };
      if (prior) delete nextHolds[slotKey];
      nextHolds[slotKey] = {
        mode: "preview",
        kind,
        fxId: "",
        startS,
        priorFx: [],
      };
      set({ fxHolds: nextHolds });
      return;
    }

    const bpm = s.jobMeta?.bpm?.value ?? null;
    const lengthS = defaultTapLengthS(kind, bpm);

    // If a stale prior hold exists on this slot (Safari can fire
    // keydown twice without keyup on inactive-window resume), start
    // from its priorFx baseline instead of stacking it on top.
    const prior = s.fxHolds[slotKey];
    const baselineFx = prior ? prior.priorFx : s.fx;
    // The new entry's priorFx is the snapshot WE see — i.e. what to
    // restore on cancel. After clobber/insert, that's the baseline.
    const priorFx = baselineFx.slice();

    // Tape-overwrite: clobber non-live same-kind fx that overlap the
    // default-tap window. Live FX (currently held by other slots) are
    // skipped via liveIds.
    const liveIds = new Set<string>();
    for (const [k, h] of Object.entries(s.fxHolds)) {
      if (k !== slotKey && h.fxId) liveIds.add(h.fxId);
    }
    const outS = Math.max(startS + lengthS, startS + FX_MIN_WINDOW_S);

    // Bake what the panel encoders are currently showing into the new
    // capsule so it's frozen at write-time (Recording Head — what was
    // on the knobs at the moment of the press is what gets recorded).
    // Same freeze logic for the ADSR envelope. Computed before clobber
    // so the clobber pass can see the full footprint of the new fx
    // including its release tail.
    const id = makeFxId();
    const userDefaults = s.fxDefaults[kind];
    const params =
      userDefaults && Object.keys(userDefaults).length > 0
        ? { ...userDefaults }
        : undefined;
    const userEnv = s.fxEnvelopes[kind];
    const catalogEnv = fxCatalog[kind]?.defaultEnvelope;
    const envelope: ADSREnvelope = userEnv ?? catalogEnv ?? INSTANT_ENVELOPE;
    // Freeze the full modulation (envelope + the kind's modulator config)
    // into the capsule, mirroring the encoder/envelope recording-head
    // freeze — what's dialled in at the moment of the punch is what plays.
    const modCfg = s.fxModulations[kind] ?? DEFAULT_MOD_CONFIG;
    const modulation: Modulation = {
      envelope: { ...envelope },
      timeMod: modCfg.timeMod,
      depth: modCfg.depth,
      lfo: { ...modCfg.lfo },
      side: { ...modCfg.side },
    };
    // Clobber sees the new fx's eventual footprint (incl. release
    // tail) so a rapid same-spot retrigger erases the previous fx in
    // full instead of leaving a release-tail stub behind. Also tape-
    // splits inside an old fx land at the new fx's actual end, not
    // its zero-width head.
    const clobberEndS = outS + envelope.releaseS;
    const clobbered = clobberSameKindOverlapping(
      baselineFx,
      kind,
      startS,
      clobberEndS,
      liveIds,
    );
    const newFx: PunchFx = {
      id,
      kind,
      inS: startS,
      outS,
      params,
      envelope: { ...envelope },
      modulation,
    };
    const nextFx = [...clobbered, newFx];

    const nextHolds: Record<string, FxHoldEntry> = { ...s.fxHolds };
    if (prior) delete nextHolds[slotKey];
    nextHolds[slotKey] = {
      mode: "persistent",
      kind,
      fxId: id,
      startS,
      priorFx,
    };

    set({ fx: nextFx, fxHolds: nextHolds });
  },
  tickFxHold(slotKey, currentS) {
    const s = get();
    const hold = s.fxHolds[slotKey];
    if (!hold) return;
    // Preview holds don't have an fx to grow — the renderer overlays
    // the effect at full strength while held, no timeline state.
    if (hold.mode === "preview") return;
    const liveFx = s.fx.find((f) => f.id === hold.fxId);
    if (!liveFx) return;
    // Push outS *past* the playhead by HOLD_OVERSHOOT_S so the FX stays
    // active across RAF tick boundaries. Without the buffer, the moment
    // currentTime catches up to outS the active-resolver (`t < outS`)
    // marks the FX inactive — the vignette flickers off mid-hold.
    // Only grow: backwards moves keep the larger value (matches live-
    // performance feel — hold longer ↔ longer capsule, never shrinks
    // under your fingertip).
    const target = currentS + FX_HOLD_OVERSHOOT_S;
    if (target <= liveFx.outS) return;
    // Tape-overwrite: as the live range grows, eat any non-live
    // same-kind fx in its path. Skip the live fx itself.
    const liveIds = new Set<string>();
    for (const h of Object.values(s.fxHolds)) liveIds.add(h.fxId);
    const clobbered = clobberSameKindOverlapping(
      s.fx,
      liveFx.kind,
      hold.startS,
      target,
      liveIds,
    );
    // Build the next fx array: clobbered list with the live fx's outS
    // pushed to target. Single set() merges what used to be two
    // (`set({fx: clobbered})` + `setFxOut`).
    const clampedOut = Math.max(target, liveFx.inS + FX_MIN_WINDOW_S);
    const nextFx = clobbered.map((f) =>
      f.id === hold.fxId ? { ...f, outS: clampedOut } : f,
    );
    set({ fx: nextFx });
  },
  endFxHold(slotKey) {
    const cur = get().fxHolds;
    const hold = cur[slotKey];
    if (!hold) return;
    // Preview hold: no fx to finalise — just drop the entry. The
    // overlay disappears on the next render tick.
    if (hold.mode === "preview") {
      const next = { ...cur };
      delete next[slotKey];
      set({ fxHolds: next });
      return;
    }
    // Snap the committed out-edge to the active grid. The in-edge was
    // snapped at beginFxHold; mirroring that on release means tap and
    // hold both produce on-grid ranges. Falls back to the live outS
    // (with overshoot) if the snap would shrink below in + min-window
    // — recording never collapses a fx under the user's fingertips.
    const fx = get().fx.find((f) => f.id === hold.fxId);
    if (fx) {
      // The live tick keeps outS at currentS + overshoot, so
      // `outS - overshoot` is the latest playhead position we know about.
      // We use that as the release time instead of reading playback.
      // currentTime again — the latter may have advanced past our last
      // observation, and during tests there's often no playback at all.
      const releaseS = Math.max(fx.inS, fx.outS - FX_HOLD_OVERSHOOT_S);
      const snappedRelease = get().snapTimelineTime(releaseS);
      // Synth-voice release: the region must extend BEYOND the user's
      // release moment by `envelope.releaseS` seconds so the release
      // phase actually has time to fade. Without the tail, `outS` lands
      // at the snapped release moment and the playhead is past the
      // region instantly — effect cuts off hard. Snap stays at the
      // user-perceived moment; only the tail is appended (off-grid).
      const releaseTailS = fx.envelope?.releaseS ?? 0;
      const finalOut = Math.max(
        fx.inS + FX_MIN_WINDOW_S,
        snappedRelease + releaseTailS,
      );
      if (Math.abs(finalOut - fx.outS) > 1e-6) {
        set({
          fx: get().fx.map((f) =>
            f.id === hold.fxId ? { ...f, outS: finalOut } : f,
          ),
        });
      }
    }
    const next = { ...cur };
    delete next[slotKey];
    set({ fxHolds: next });
  },
  cancelFxHold(slotKey) {
    const hold = get().fxHolds[slotKey];
    if (!hold) return;
    const next = { ...get().fxHolds };
    delete next[slotKey];
    if (hold.mode === "preview") {
      // Nothing was written to fx[] — just drop the hold record.
      set({ fxHolds: next });
      return;
    }
    // Revert: drop only the fx this hold introduced. Other live holds
    // keep their fx (we don't full-revert to priorFx, that would clobber
    // simultaneously-held FX from other slots).
    const fxNext = get().fx.filter((f) => f.id !== hold.fxId);
    set({ fx: fxNext, fxHolds: next });
  },
  cancelAllFxHolds() {
    const holds = get().fxHolds;
    const liveIds = new Set(
      Object.values(holds)
        .filter((h) => h.mode === "persistent")
        .map((h) => h.fxId),
    );
    const fxNext = get().fx.filter((f) => !liveIds.has(f.id));
    set({ fx: fxNext, fxHolds: {} });
  },
  eraseFxAt(t, kinds) {
    const liveIds = new Set(
      Object.values(get().fxHolds)
        .filter((h) => h.mode === "persistent")
        .map((h) => h.fxId),
    );
    const matchKind = (k: FxKind): boolean =>
      kinds === "all" ? true : kinds.includes(k);
    // Tape-erase: the head is a ~150 ms window centered on t. Only the
    // strip of an fx that lives *under the head* is wiped — anything
    // outside the head survives. A head straddling the front edge of
    // an fx trims its inS forward; the back edge trims its outS back;
    // a head inside an fx splits it into two pieces.
    const cutLow = t - FX_ERASE_DELTA_S / 2;
    const cutHigh = t + FX_ERASE_DELTA_S / 2;
    const next: PunchFx[] = [];
    for (const f of get().fx) {
      if (!matchKind(f.kind) || liveIds.has(f.id)) {
        next.push(f);
        continue;
      }
      // No overlap → keep as-is.
      if (cutHigh <= f.inS || cutLow >= f.outS) {
        next.push(f);
        continue;
      }
      // Head fully covers the fx → drop entirely.
      if (cutLow <= f.inS && cutHigh >= f.outS) {
        continue;
      }
      // Head straddles front edge (cuts off the head of the fx).
      if (cutLow <= f.inS && cutHigh < f.outS) {
        const trimmed: PunchFx = { ...f, inS: cutHigh };
        if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) next.push(trimmed);
        continue;
      }
      // Head straddles back edge (cuts off the tail of the fx).
      if (cutLow > f.inS && cutHigh >= f.outS) {
        const trimmed: PunchFx = { ...f, outS: cutLow };
        if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) next.push(trimmed);
        continue;
      }
      // Head strictly inside fx → split into [inS, cutLow] + [cutHigh, outS].
      const left: PunchFx = { ...f, outS: cutLow };
      const right: PunchFx = { ...f, id: makeFxId(), inS: cutHigh };
      if (left.outS - left.inS >= FX_MIN_WINDOW_S) next.push(left);
      if (right.outS - right.inS >= FX_MIN_WINDOW_S) next.push(right);
    }
    set({ fx: next });
  },
  setSelectedFxKind(kind) {
    if (get().selectedFxKind === kind) return;
    set({ selectedFxKind: kind });
  },
  setFxDefault(kind, paramId, value) {
    const cur = get().fxDefaults;
    const sub = cur[kind] ?? {};
    if (sub[paramId] === value) return;
    set({
      fxDefaults: {
        ...cur,
        [kind]: { ...sub, [paramId]: value },
      },
    });
  },
  setFxEnvelope(kind, partial) {
    const cur = get().fxEnvelopes;
    const baseline =
      cur[kind] ?? fxCatalog[kind]?.defaultEnvelope ?? INSTANT_ENVELOPE;
    const next: ADSREnvelope = {
      attackS: partial.attackS ?? baseline.attackS,
      decayS: partial.decayS ?? baseline.decayS,
      sustain: partial.sustain ?? baseline.sustain,
      releaseS: partial.releaseS ?? baseline.releaseS,
    };
    // Skip the set when nothing actually changed — keeps zustand
    // subscribers (and the RAF preview) idle on no-op drags.
    const prev = cur[kind];
    if (
      prev &&
      prev.attackS === next.attackS &&
      prev.decayS === next.decayS &&
      prev.sustain === next.sustain &&
      prev.releaseS === next.releaseS
    ) {
      return;
    }
    set({ fxEnvelopes: { ...cur, [kind]: next } });
  },
  resetFxEnvelope(kind) {
    const cur = get().fxEnvelopes;
    if (!(kind in cur)) return;
    const next = { ...cur };
    delete next[kind];
    set({ fxEnvelopes: next });
  },
  setFxTimeMod(kind, timeMod) {
    const cur = get().fxModulations[kind] ?? DEFAULT_MOD_CONFIG;
    set({
      fxModulations: { ...get().fxModulations, [kind]: { ...cur, timeMod } },
    });
  },
  setFxModDepth(kind, depth) {
    const cur = get().fxModulations[kind] ?? DEFAULT_MOD_CONFIG;
    const clamped = depth < 0 ? 0 : depth > 1 ? 1 : depth;
    set({
      fxModulations: {
        ...get().fxModulations,
        [kind]: { ...cur, depth: clamped },
      },
    });
  },
  setFxLfo(kind, patch) {
    const cur = get().fxModulations[kind] ?? DEFAULT_MOD_CONFIG;
    set({
      fxModulations: {
        ...get().fxModulations,
        [kind]: { ...cur, lfo: { ...cur.lfo, ...patch } },
      },
    });
  },
  setFxSidechain(kind, patch) {
    const cur = get().fxModulations[kind] ?? DEFAULT_MOD_CONFIG;
    set({
      fxModulations: {
        ...get().fxModulations,
        [kind]: { ...cur, side: { ...cur.side, ...patch } },
      },
    });
  },
  setAudioEnv(env) {
    set({ audioEnv: env });
  },
});
