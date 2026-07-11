/**
 * Punch-In Effect (P-FX) — visueller Effekt mit In/Out-Punkten auf der
 * Master-Timeline. Anders als Cuts (exklusive Cam-Switches) überlappen
 * P-FX frei und stapeln sich; ein Pixel kann mehreren FX angehören.
 *
 * Pad-Bank: V (vignette), W (wear), E (echo), R (rgb), T (tape),
 * Z (zoom), U (uv). Vignette ist V1 mit echtem Renderer; die anderen
 * sechs sind aktuell Debug-Stubs (farbiger Frame + Label-Tag) — die
 * Pad-/Encoder-/Tastatur-/Selection-Mechanik läuft trotzdem ende-zu-ende.
 */

export type FxKind =
  | "vignette"
  | "wear"
  | "echo"
  | "rgb"
  | "tape"
  | "zoom"
  | "uv"
  /** Global color-grade pass (the "film stock" layer). Unlike the other
   *  kinds it is NOT a momentary punch-in accent: the descriptor builder
   *  emits one `grade` FrameFx, prepended ahead of the accents so they
   *  composite on top of the graded frame. Its params are the full
   *  `GradeParams` vector (see ./looks), not a 2-knob pair, so its catalog
   *  entry exposes no `params` tuple. Edited via the Color-grade surface. */
  | "grade"
  /** Global "filter" looks — opinionated, recognizable, each its OWN effect
   *  with its OWN controls (see FxDefinition.filterParams). Applied as a
   *  stack UNDER the punch-in accents (above the grade), edited in the
   *  Overlays panel's Filters section. */
  | "vhs"
  | "super8"
  | "decay"
  | "noir"
  | "sepia"
  | "polaroid";

/** Encoder-Verhalten eines Param.
 *
 *  - `linear`  — kontinuierliche 0..max Skala (DEPTH, EDGE, AMOUNT, …).
 *  - `bipolar` — TE-LFO-Style. Linke Hälfte free, rechte Hälfte snapped
 *                auf Beat-Stops (1/16 1/8 1/4 1/2 1 2 4). Mitte = OFF.
 *                Wird für zeitbasierte Params benutzt (RATE, BEND, …).
 */
export type FxParamKind = "linear" | "bipolar";

/** Beschreibt einen einzelnen Knob-Param eines FX. Trägt sowohl die
 *  UI-Metadaten (label, kind) als auch den storage-range (min/max), so
 *  dass der Encoder display 0..100 ohne weitere mappers ableitet:
 *    display = round(((value - min) / (max - min)) * 100)
 *  Renderer arbeiten weiterhin auf dem nativen storage-Wert. */
export interface FxParamDef {
  /** Stable id — Schlüssel im PunchFx.params + UserDefaults Storage. */
  id: string;
  /** Engraved label (≤ 6 chars uppercase, e.g. "DEPTH"). */
  label: string;
  /** Encoder-Verhalten. */
  kind: FxParamKind;
  /** Default im Storage-Range. */
  defaultValue: number;
  /** Untergrenze des Storage-Ranges. */
  min: number;
  /** Obergrenze des Storage-Ranges. */
  max: number;
}

/** One stacked global FILTER in the Overlays panel — picks an opinionated
 *  filter kind (vhs / super8 / sepia / …) and carries that kind's own param
 *  values (its `filterParams` schema, including the master `amount`). Slots
 *  compose serially top→bottom, UNDER the punch-in accents. */
export interface FilterSlot {
  id: string;
  kind: FxKind;
  params: Record<string, number>;
}

export interface PunchFx {
  id: string;
  kind: FxKind;
  /** Master-time inclusive start. */
  inS: number;
  /** Master-time exclusive end. */
  outS: number;
  /** Kind-spezifische Parameter. Optional — falls fehlend, nutzen die
   *  Renderer die `defaultParams` aus der FxDefinition. */
  params?: Record<string, number>;
  /** ADSR-Hüllkurve für Wet/Dry-Crossfade über die Region-Dauer.
   *  Optional — fehlt → INSTANT_ENVELOPE (Bit-Parity zu Pre-V1).
   *  Legacy-Feld: bei gesetztem `modulation` ist dessen `envelope`
   *  maßgeblich; ohne `modulation` wird hieraus eine envelope-only
   *  Modulation (depth 0) synthetisiert → identisches Rendering. */
  envelope?: import("./envelope").ADSREnvelope;
  /** Uniforme Modulation: Envelope ⊗ (LFO | Sidechain). Wenn gesetzt, die
   *  alleinige Quelle für Intensität (`level`) + `phase`. Optional für
   *  Bit-Parity zu Bestands-FX, die nur `envelope` tragen. */
  modulation?: import("./modulation").Modulation;
}

/** Minimal-Snapshot, der einer FxDefinition reicht, um zu rendern.
 *  Tests können das ohne den Catalog-Lookup direkt aufrufen. */
export interface FxRenderInput {
  fx: PunchFx;
  /** Master-time. Renderer normalisieren ggf. auf fx-lokal. */
  t: number;
  /** Output-Dimensionen in Pixeln. */
  w: number;
  h: number;
}
