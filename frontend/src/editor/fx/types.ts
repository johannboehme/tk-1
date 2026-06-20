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
  | "uv";

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
