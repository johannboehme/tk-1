# Long-Form Session-Footage Triage Workflow

## Context

Aktuell ist die App auf den Workflow „fertiger Song + Video → schneiden" zugeschnitten. Der Großteil der TE-Musiker-Zielgruppe filmt aber **stundenlange Build-Sessions** (Sample-Suche, Chops bauen, Layern, Pausen, Toilettengänge) und will daraus ein paar prägnante Minuten als Musikvideo schneiden — ohne sich das ganze Footage manuell durchzusehen.

**Lösung**: Drei-Phasen-Workflow, der zwischen Upload und Editor lebt:

```
Upload (zwei Knöpfe: Direkt / Session)
   │
   ├── "Fertiger Song"  ───────────────────────────► Editor
   │
   └── "Session-Mitschnitt"
          │
          ▼
      ① Triage  ──►  ② Arrange  ──►  ③ Editor
      identify     sequence       compose
```

- **Triage**: erkennt Stille-Pausen, schlägt musikalische Chunks vor (Bar-aligned per Chunk-eigenem audioStart-Onset bei song-globalem BPM), User akzeptiert/verwirft/trimmt. Multi-Cam-Preview via Cam-Picker im Preview-Frame.
- **Arrange**: User sortiert die akzeptierten Chunks per Mini-Arranger, kann duplizieren, kann Polaroids aus dem Contact-Sheet in den Strip ziehen.
- **Editor**: bekommt eine vorbefüllte EditSpec mit Multi-Pill-Lanes (mehrere Sub-Ranges pro Cam), Master-Audio bleibt unangetastet, Segments[] wird zur Playlist.

**Constraints (non-negotiable)**:
- Memory-konstant bei 1h+ / multi-GB Footage (File-Handles + Streaming-Decoder existieren bereits)
- Audio-Wiedergabe rock-solid für die latenz-empfindliche Zielgruppe (kein Knack/Klick bei Chunk-Übergängen)
- Bar-Snap muss sich DAW-mäßig anfühlen (magnetisch, mit Modifier-Override = Shift, NLE-Konvention)

---

## Schlüssel-Entscheidungen

1. **Master-Audio bleibt Original** — kein Re-Encode. Segments[] (existiert in EditSpec) wird zur logischen Playlist; Playback springt zwischen Original-Zeitbereichen via Crossfade-Pattern aus `useAudioMaster` (existiert).
2. **Sync ist Job-Property** — auto-sync läuft wie bisher als allererster Step. Manuelles Nudging im Editor (in Triage gibt's keinen SyncPatch mehr — der Cam-Picker im Preview reicht für Curation).
3. **Chunks und Arrangement leben am Job, nicht in EditSpec** — überleben Editor-Edits. Editor-Edits sind chunk-lokal (keyed über pill-id der vom chunk-id abgeleitet wird) und überleben das Hinzufügen neuer Chunks in Triage.
4. **Triage = stripped-down Editor-Scaffold** über **shared View-Components** (Props-getrieben). Jede zentrale Editor-Komponente wurde in einen `<View>`-Twin extrahiert: `BpmReadout(View)`, `SnapModeButtons(View)`, `TransportClock(View)`. Editor mountet store-bound Wrapper, Triage mountet View direkt mit eigenem Store. **Kein Mode-Toggle im Editor.**
5. **Multi-Pill-Lane-Refactor wird so spät wie möglich gemacht** — erst kurz vor „Send to Editor" (Phase 6).
6. **Cam-Wahl pro Frame bleibt Editor-Job** — Triage zeigt Cams nur als Preview-Switcher (Dropdown im Cam-Label des Preview-Frames). Bäckt keine Cut-Entscheidungen vor, kein Per-Cam-Sync-Nudging.
7. **Cherry-Picking nur an EINER Stelle** — Keep/Drop ausschließlich auf der TransportBar (Enter / Backspace). Inspector + ChunksList haben keine eigenen Buttons.
8. **BPM ist song-global, Bar-Phase ist per-Chunk** — siehe Tempo-Modell unten. **NICHT per-Chunk-BPM-Override.**
9. **Snap-Bypass = Shift** — editor-konform (NLE-Standard). NICHT Alt.
10. **Frontend-Design Skill ist Pflicht** für jede UI-Phase. TE-Spirit (skeuomorph, Real-World-Music-Gear). Brass-bezel + LCD vocabulary für alle Readouts (BPM, TimeSig, Clock, KEPT-Counter, MIN-Filter), cassette-deck für Mode-Selectors (Snap).
11. **Strip-Rotation wird beim Extract gebaken** — `extractFrameStripWebcodecs/Ffmpeg` nehmen `rotationDeg` und schreiben display-orientierte Tiles. Cam bekommt `framesOrientation: "display"`. Keine per-Consumer-Rotations-Logik mehr.

---

## Tempo-Modell (wichtig)

Long-form Sessions sind nicht zueinander beat-aligned: Musiker spielen los, machen Pause, testen Samples, time-stretchen. Whole-File-BPM-Detection liefert auf solchem Material Müll. Lösung:

- **`job.bpm`** = song-globaler Tempowert (eine Zahl) — Mode der per-Chunk-detected-BPMs (gewichtet nach Chunk-Dauer, gerundet); user-überschreibbar via `BpmReadoutView` in Triage und Editor.
- **`chunk.audioStartMs`** = pro-Chunk Onset (master-time, ms) — Anchor für den Bar-Grid dieses Chunks. Chunks sind nicht zueinander aligned, jeder hat seinen eigenen Phase.
- Bar-Grid eines Chunks = Beat-Step (60/`job.bpm`) × `job.beatsPerBar`, anchored an `chunk.audioStartMs`.
- Per-Chunk-BPM-Override im UI **gibt es nicht** — `chunk.detectedBpm` und `chunk.bpmOctaveShift` bleiben im Storage-Schema für Backward-Compat, sind aber UI-tot.

`pickGlobalBpm(chunks)` (in `chunk-detect.ts`): bucketet die per-Chunk detectedBpms gerundet, weight = Chunk-Dauer in Sekunden, höchste Count gewinnt; Tiebreak per Weight. Liefert `null` wenn keiner detected hat — Triage-Page macht dann Triple-Fallback (`job.bpm` → `getCachedAnalysis(jobId).tempo` → `pickGlobalBpm(job.chunks)`).

---

## Datenmodell-Erweiterungen

```ts
// Job-Level
type JobMode = "direct" | "longform";

interface SilenceConfig { thresholdDb: number; minPauseMs: number; }

interface Chunk {
  id: string;                     // stable ID, survives re-detection
  startMs: number;                // master-audio time (silence boundary)
  endMs: number;
  /** Pro-Chunk Onset (master-time, ms). Anchor für den Bar-Grid
   *  dieses Chunks. Default = startMs wenn kein Onset detected. */
  audioStartMs?: number;
  /** Vom Detection-Worker pro Chunk erkanntes BPM. Wird zur globalen
   *  Mode-Aggregation verwendet, treibt aber NICHT den Bar-Grid. */
  detectedBpm?: number;
  /** UI-tot. Nur Storage-Compat. */
  bpmOctaveShift: 0 | -1 | 1;
  effectiveBpm: number;           // UI-tot, nur Storage-Compat
  beatsPerBar: number;            // default 4, UI-tot (job.beatsPerBar gilt)
  accepted: boolean;              // include in arrangement (USER-Decision)
  trimMode: "auto" | "bar" | "free";
  trimStartMs?: number;
  trimEndMs?: number;
}

interface ArrangementItem {
  id: string;
  chunkId: string;
}

// VideoAsset extension (relevante neue Felder)
interface VideoAsset {
  // ... existing fields ...
  intrinsicRotationDeg?: 0 | 90 | 180 | 270;
  /** "display" = strip tiles bereits upright (rotation gebaken).
   *  "codec" / undefined = legacy strips, Consumer muss rotation
   *   selbst anwenden. */
  framesOrientation?: "codec" | "display";
}

// LocalJob extension (existiert bereits, hier zur Vollständigkeit)
interface LocalJob {
  // ...
  mode: JobMode;
  silenceConfig?: SilenceConfig;
  bpm?: { value: number; confidence: number; phase: number; manualOverride?: boolean };
  beatsPerBar?: number;
  barOffsetBeats?: number;
  ui?: { snapMode?: SnapMode; lanesLocked?: boolean };
  chunks?: Chunk[];
  arrangement?: ArrangementItem[];
  triageEnvelope?: Float32Array;
}

// Editor: multi-pill refactor (Phase 6, NOT done yet)
interface VideoLane {
  id: string;
  source: AssetSource;
  color: string;
  syncOffsetMs: number;
  syncOverrideMs?: number;
  driftRatio?: number;
  pills: Pill[];
}

interface Pill {
  id: string;
  trimInS: number;
  trimOutS: number;
  startOffsetS: number;
  fromChunkId?: string;
  fromArrangementId?: string;
}
```

---

## Phasen-Übersicht

| Phase | Status | Beschreibung |
|-------|--------|--------------|
| 1. Routing + Entry | ✅ done | Mode-Wahl beim Upload, Triage/Arrange-Routes, JobPage routing |
| 2. Detection Backend | ✅ done | WASM silence_segments, per-chunk BPM + per-chunk audioStartMs, Mode-Aggregation, im Sync-Step |
| 3. Triage UI | ✅ done | Vom User abgenommen — Layout, Snap, Adaptive Ruler, BPM-Widget, Min-Bars-Filter, Cam-Picker, Help-Overlay |
| 4. Triage Polish | ✅ kollabiert in Phase 3 | Click-through, bar-snap, gapless audio, adaptive ruler — alles in Phase 3 reingefaltet |
| 5. Arrange Phase | ✅ done | Filmstreifen + Polaroid Contact-Sheet + Drag-Drop, Strip-Rotation gebaken, Cam-Picker shared mit Triage |
| 5b. Arrange Polish + Cockpit-Glance | ✅ done | Bar-Cleanup (Icons + Cluster), Frame-Bezel skeuomorph, OP-1-Phosphor-Cockpit mit Mel-Spec + Auto-Tags + Stem-Bars, KEY-Detection (Krumhansl), Spectral Color-Tag, Click-to-seek im Spektrogramm, Walker-Audio-Loop (statt Time-Match → fixes Duplicate-Loop), Click-never-changes-playstate, Tier-2-Skip für portrait clips |
| 6. Multi-Pill Editor Refactor | 🚧 nicht angefangen | Großer Brocken — explizit übersprungen, weil Arrange + Phase 7 Wiring auch ohne den Refactor funktionieren |
| 7. Send to Editor + Segment Playback | ✅ Wiring done, ungeprüft | `arrangementSegments[]` im Editor-Store; `useAudioMaster` walked sie via Crossfade-Hop; Timeline dimmt off-segment Regionen. **Phase-7-Behavior nicht E2E vom User getestet.** |
| 8. Polish | 🚧 nicht angefangen | Sensitivität, Performance, Documentation |

---

## Phasen-Details

### Phase 1 — Routing, Entry-Point, Job-State-Machine ✅

**Umgesetzt**:
- Upload-Page mit zwei ChunkyButton-Cards (`03A · DIRECT` / `03B · SESSION`)
- LocalJob-Felder: `mode`, `silenceConfig`, `chunks`, `arrangement`, `triageEnvelope` (alle optional)
- Routes `/job/:id/triage`, `/job/:id/arrange` hinter `JobPermissionRoute`
- `nextRouteForJob()` als Single-Source-of-Truth fürs Routing — `arrangement === undefined` ist die „Triage done"-Marke
- PhaseStrip-Component shared zwischen Triage + Arrange
- **JobPage** zeigt für longform-Jobs alle erreichten Stages (Triage / Arrange / Editor) als Buttons — User springt direkt zurück in jede schon erreichte Phase, primary-highlight = aktuelle Stage

---

### Phase 2 — Detection Backend ✅

**Umgesetzt**:
- WASM `silence.rs` mit `silence_segments(envelope, threshold_lin, min_pause_ms)`
- TS `chunk-detect.ts`:
  - `detectChunks(pcm, sr, config)` produziert Chunks mit `detectedBpm` + `audioStartMs` (per-Chunk Onset via `analyzeAudio()` auf PCM-Slices, skipped für < 4s)
  - `detectChunksFromEnvelope` für live Slider-Updates ohne PCM-Re-Decode
  - `pickGlobalBpm(chunks)` aggregiert per-Chunk-BPMs zur einen Job-Zahl (mode + duration-weighted tiebreak)
- **Sync-Step Integration** (`runSync` in `jobs.ts`, pct 97): `detectChunks()` läuft, `pickGlobalBpm()` schreibt `job.bpm` (manualOverride: false) wenn nicht user-überschrieben
- 13 browser-tests (`chunk-detect.browser.test.ts`)

**Files**: `wasm/sync-core/src/silence.rs`, `src/local/triage/chunk-detect.ts`, `src/local/triage/triage-orchestrator.ts`, `src/local/jobs.ts`

---

### Phase 3 — Triage UI ✅

Vom User abgenommen. Funktional + design-poliert.

**Layout — vier-Regionen-Rack (`src/pages/Triage.tsx`):**
1. **PhaseStrip** (h-12) — back, phase dots, title, `?`-Help-Button, Continue-Button
2. **ControlRow** (`flex-1 min-h-[18rem]`) — drei gleich-hohe Spalten:
   - Cam Preview (1.5fr, `aspect-video`, `<CamPickerDropdown>` im Corner-Badge)
   - Inspector (1.1fr, `BpmReadoutView` im Header, KV-Grid + Trim-by-bar im scrollable Body)
   - ChunksList (0.6fr, kompakte Rows mit `from → to` + Länge + DROP/FILT-Badges)
3. **DeckStrip** (h-20, brushed-metal) — `SnapModeButtonsView` (cassette-Plate, ohne MATCH) + Detection-Sliders + `MIN`-Filter-LCD + `KEPT`-Counter-LCD
4. **Timeline** (flex-none, h-188, full width) — `TriageTimeline`
5. **TransportBar** — 3-col grid: Clock (links), Buttons-Cluster (zentriert: Prev/Play/Next │ Keep/Drop │ Loop), Counter-Reserve-Spalte rechts

Page wrapper ist `h-screen overflow-hidden` damit ControlRow's flex-1 wirklich auf Viewport-Höhe greift und ChunksList intern scrollt.

**TriageTimeline (`src/components/triage/TriageTimeline.tsx`):**
- Vier Layer übereinander: Time-Ruler | Bar-Ruler (zeigt nur fokussierten Chunk) | Waveform | Chunk-Lane
- **Adaptive Density** — power-of-2 Stride für bar-major (Labels ≥ 56 px), bar-minor / beat / div8 / div16 schalten zoom-abhängig zu
- Pointer: Click in Chunk-Lane → focus, Click in Waveform-Y-Range auf Chunk → focus + Seek, Click in Ruler → nur Seek
- Trim-Drag per `data-trim-handle`, Snap nutzt `chunk.audioStartMs` als beatPhase, `job.bpm` als step
- **Snap-Bypass = Shift** (NLE-Konvention)
- Mouse-Wheel zoom anchored am Cursor, Pinch + 1-finger-pan auf Touch
- Chunk-Block-Width matcht reale Dauer (kein min-clamp)

**TransportBar (`src/components/triage/TriageTransportBar.tsx`):**
- Editor's `TransportClockView` reused, lokaler Wrapper subscribt nur currentTime
- Loop-Toggle ganz rechts, Shortcut `L`
- `focusRelative(±1)` walkt **effektiv-akzeptierte** Chunks (Filter + accepted)

**Inspector / DetectionPanel / ChunksList**: KV-Grid + Trim-by-bar Buttons | Threshold-/Min-Pause-Slider mit live re-detection | kompakte 28px-Rows (click-to-focus only).

**CamPreview**: `<CamPickerDropdown>` aus `src/components/CamPickerDropdown.tsx` (shared mit Arrange) im Corner-Badge.

**TriageAudioMaster (`src/components/triage/useTriageAudio.tsx`):**
- Dual-element ping-pong, 8ms WebAudio gain-crossfade, 50ms lead — gapless loop
- Respektiert `playback.loopEnabled` (default true)

**useTriagePersist**: Debounced 250ms IDB write für: chunks, silenceConfig, jobBpm, beatsPerBar, snapMode, per-cam syncOverrideMs.

**Help-Overlay**: `<HelpOverlay />` global in `App.tsx`, "?"-Key + Button im PhaseStrip. TransportBar registriert via `useRegisterShortcut`: Space, Shift+←/→, Enter, Backspace, L.

**Continue → Arrange**: Seedet `arrangement` mit effektiv-akzeptierten Chunks (chronologisch). Re-Entries fügen nur neue Chunks hinzu, behalten User-Sortierung.

---

### Phase 5 — Arrange Phase ✅

**Designkonzept (vom User abgenickt)**: 35mm-**Filmstreifen** mit Sprocket-Holes als zentrale Komponente. Polaroid-Contact-Sheet als Source-Pool drunter. Player-Cockpit oben mit kleiner Cam-Vorschau + dunklem LCD (TOTAL · NOW · ITEM · BPM). Insertion-Cursor zwischen Frames als Add-Mechanik. Inspector inline in der Bottom-Transport-Bar. Mini-Map nur bei Strip-Overflow. Default-Arrangement = 1:1 chronologisch aus Triage-akzeptierten Chunks.

**Was umgesetzt ist**:

- `src/local/arrange/`:
  - `arrange-store.ts` — zustand store mit arrangement / chunks / cams / focus / insertionIndex / selectedCam / playback / view / jobBpm / jobBeatsPerBar / `drag` (für Polaroid-→-Strip drag-state). Actions: insertChunkAtCursor, removeItem, shiftItem, reorderItem, duplicateItem, focusItem, focusRelative, setSelectedCamId, setPlaying, seek, tickTime, setStripScrollPx, setStripMetrics, beginChunkDrag, updateChunkDrag, commitChunkDrag, cancelChunkDrag.
  - `useArrangePersist.ts` — 250ms debounced IDB write für arrangement + cam syncOverrideMs.
  - `chunks-to-segments.ts` — `arrangementToSegments(arrangement, chunks)` mappt nach `EditSpec.segments[]`. Tests grün.
  - `chunk-thumbnails.ts` — **3-tier resolver** (IDB → strip-slice → on-demand video seek) mit dedupliziertem Probe-Promise pro Cam, 30s metadata-Timeout, structured Diagnose-Logging via `localStorage.__thumbDebug = '1'`. Tier 2 wendet rotation NUR für legacy-codec-strips an (für `framesOrientation: "display"` ist rotation=0).

- `src/components/arrange/`:
  - `FilmStrip.tsx` — Sprocket-Hole-Rails, length-proportional Frames, drag-on-frame-to-reorder, `data-strip-frame-index` + `data-strip-cursor-index` Attribute fürs Hit-Testing beim Polaroid-Drop.
  - `Frame.tsx` — Cam-Color-Stripe unten, focused = cobalt outline, current playing = top-LED, IntersectionObserver-gated thumbnail load.
  - `ContactSheet.tsx` — wrap-grid, scrollt intern, Header-Hint „drag to strip · or hit + ADD".
  - `Polaroid.tsx` — Develop-Animation, `+ ADD` Button, Click = preview-loop, **Pointer-Drag (5px Threshold) startet Polaroid→Strip drag**.
  - `InsertionCursor.tsx` — drei states: idle / active (clicked) / dropTarget (drag-over) — pulsing-orange Linie mit ▼ Chevron beim Drop.
  - `MiniMap.tsx` — Overflow-only; cobalt highlight für focused, hot-orange für playing.
  - `PlayerCockpit.tsx` — Cam-Sucher links + Dark-LCD (TOTAL/NOW/ITEM/BPM/REC).
  - `CamPreviewArrange.tsx` — `<CamPickerDropdown>` shared mit Triage. Sm: square 84×84, sm+: 240×135.
  - `ArrangeTransport.tsx` — PREV/PLAY/NEXT + ◀cur/cur▶ + Inspector inline (FRAME N/M, bars, ◀ ▶ Dup Drop).
  - `useArrangeAudio.tsx` — Sequenzielle gapless playback (recycelt Triage-Pattern).
  - `ChunkDragGhost.tsx` — Floating thumbnail per `createPortal`, folgt dem Cursor während Polaroid-Drag.
  - `useChunkDragController.tsx` — Window pointer-events während drag, hit-tests via `data-strip-*` attrs, commit/cancel auf pointerup/Escape.

- `src/pages/Arrange.tsx` — `h-screen overflow-hidden`, full-width single-column. **Awaitet `prefetchChunkThumbnails`** vor `setJob(j)` damit Polaroids beim ersten Mount die URL synchron via `peek()` finden (kein developing-dots-flicker). `continueToEditor()` flusht arrangement synchron in IDB bevor er navigiert.

- **Strip-Rotation gebaken** (siehe Schlüssel-Entscheidung 11):
  - `extractFrameStripWebcodecs/Ffmpeg` nehmen `rotationDeg`, planen Tiles aus post-rotation Aspect, rotieren beim Encode.
  - `runSync` in `jobs.ts` passt `intrinsicRotationDeg` durch + setzt `framesOrientation: "display"` auf der Cam.
  - Editor's Timeline (`pages/Editor.tsx` + `editor/components/Timeline.tsx`) hat aspect-Berechnung die `framesOrientation` respektiert — für „display"-strips display-aspect, sonst codec.
  - `displayDimsOf(cam)` Helper in `storage/jobs-db.ts` für consumer die display-orientation brauchen.
  - **Legacy-strips** (`framesOrientation` undefined oder "codec") laufen weiter über die manuelle Rotation in `chunk-thumbnails.ts` — kein zwangs-resync.

- **Phase 7 wiring** (kein eigener Editor-Refactor, segment-walker eingebaut):
  - `editor/store.ts` `arrangementSegments: Segment[]` field + setter; `loadJob` opts erweitert; `buildEditSpec` emittiert die Segmente verbatim wenn non-empty.
  - `editor/useAudioMaster.ts` segment-walker branch: gapless hop von segment N's `out` zu segment N+1's `in` via wrapTarget. Last segment → pause statt loop.
  - `editor/components/Timeline.tsx` dimmt off-segment Regionen + zeichnet hot splice marks an Boundaries.
  - `pages/Editor.tsx` ruft `arrangementToSegments(j.arrangement, j.chunks)`, übergibt an loadJob; trim spannt min/max aller segments.
  - `window.__lastEditorSegments` als E2E-debug-hook (offen committed; rausziehen wenn finalisiert).

- **IDB schema**: v3 → v4 (`chunk-thumbnails` store) → v5 (auto-clear chunk-thumbnails on migration) → v6 (`chunk-mel-specs` store) → v7 (auto-clear chunk-thumbnails after slicer-quality fix).

**Schreib-/Architektur-Entscheidungen**:
- Inspector lebt in der Bottom-Transport-Bar (kein Side-Bar) — User wollte vertikalen Platz für Strip + Contact-Sheet.
- ContactSheet wraps statt horizontal-scroll.
- `h-screen overflow-hidden` (Triage-Pattern) damit `flex-1` greift.

---

### Phase 5b — Arrange Polish + Cockpit-Glance ✅

User hat Phase 5 abgenommen, in dieser Sub-Session sind alle Polish-Punkte gelandet die in der ersten Plan-Datei (`das-ist-eine-session-expressive-hopper.md`) gelistet waren plus diverse Bugs/UX-Wishes die unterwegs auftauchten.

**Bottom-Bar (`ArrangeTransport.tsx`)**:
- CUR-Buttons + alte Inspector-`◀/▶` raus.
- Inspector-Cluster: `[SHIFT◀] [Dup] [Drop] [SHIFT▶]` mit Hairline-Divider zwischen Move- und Edit-Paar.
- Icons: `CopyIcon` + `TrashIcon`. Text-Labels weg.
- ChunkyButton's `children` ist jetzt optional damit icon-only Buttons sauber durchgehen.
- Tooltips zeigen die finalen Shortcuts.

**Frame-Selection skeuomorph (`Frame.tsx`)**:
- Cobalt-Outline weg. Stattdessen 3-fach Tell: hot-orange outer ring + brass-bezel inner hairline + soft phosphor halo.
- Selection-Tooth: bevelter Trapez-Pip oben am Frame (statt flachem Chevron).
- `animate-frame-pulse` keyframe pulsiert subtil wenn fokussiert-aber-nicht-spielend.
- Playing-Cap auf 3px hoch + 4px inset → Selected+Playing co-existieren visuell.
- `data-strip-frame-id={item.id}` für Auto-Scroll-Lookup.

**Auto-Center + Auto-Follow (`FilmStrip.tsx`)**:
- `useEffect` scrollt fokussiertes Item smooth in die Mitte des Strips.
- Zweiter `useEffect` zieht focus dem `currentItemId` während Playback hinterher (kein currentItemId-dep, damit User-Picks nicht sofort zurückgesnapt werden).

**Cockpit-LCD (`PlayerCockpit.tsx`)**:
- OP-1 Phosphor-Look: wine-black sunken background, baked PHOSPHOR_LUT (256-entry RGB ramp: floor → mid copper → peak amber).
- Linker Stat-Stack: TOTAL · ITEM · BPM · NOW · PLAY/READY (alle phosphor-glow).
- Mel-Canvas (`putImageData` mit n_mels × n_frames, browser-bilinear scale = "phosphor bleed for free"). Click-to-seek auf das Spektrogramm — translates 0..1 fraction → master-time inside `showChunk`. Cursor `crosshair`, role="button". Setzt currentItemId mit, falls man in einen anderen Chunk klickt während Playback.
- Echter Playhead: `playheadFraction = (currentTime*1000 - chunk.startMs) / span` — exakt synchron, nur sichtbar wenn `currentItemId === showItemId`.
- Auto-Tags-Reihe: KEY · DENS · BRGT · PEAK in BezelStrip + BezelCells mit BezelDividern.
- Stem-Bars (sm+ only, 180px wide BezelStrip): DRMS · BASS · MEL · FRMT als 4-row meter.
- CamPreview: `sm:h-auto sm:self-stretch sm:min-h-[135px]` damit es höhenmäßig mit dem LCD mitwächst (kein Spalt drunter).

**Audio-Pipeline (Phase C.1 + Walker-Refactor)**:
- WASM `mel.rs`: STFT mit realfft (n_fft=2048, hop=sr/fps), Slaney-Style mel-filter-bank (default 64 mels), log-magnitude → u8 (0=floor, 255=peak). 6 unit-tests grün (sine concentrates, silence is zero, noise spreads, etc.).
- WASM `chromaProfile()` als zusätzlicher Export — time-averaged 12-bin pitch-class profile pro Chunk. `class 0 = C`. L2-normalisiert.
- `chunk-mel.ts` + `chunk-mel.worker.ts`: pro-chunk Pipeline. Worker computed mel + chroma im selben Pass, transferable buffers.
- `chunk-mel.ts` exports: `chunkAutoTags(chunk, analysis, mel?)`, `keyFromChroma(chroma)` (Krumhansl-Schmuckler über die 12-bin Profile-Tables MAJ/MIN), `chunkSpectralColor(chunk, analysis)` (8-stop HSL ramp im Phosphor-Spirit, gedämpfte Pastels), `chunkStemHeuristic(chunk, analysis)` (4-band Energy + per-band onset-density → drums/bass/melody/formants).
- `useChunkMelSpecs` Hook: lädt aus IDB, was fehlt computed der Worker sequenziell (CONCURRENCY=1) im Hintergrund. Master-PCM wird einmalig per `decodeAudioToMonoPcm(blob, 22050)` decoded. **Audio-Walker-Refactor** in `useArrangeAudio.tsx`: `currentItemId` ist authoritativer State (gesetzt von setPlaying / seekToItem / Crossfade-Hop), **NICHT mehr** via master-time matching. Fixes den Endless-Loop bei chunk-Duplikaten in der Arrangement.
- `seekToItem(itemId)` action im Store: focus + currentItemId + seek auf chunk-start in einem move. Wird genutzt von Frame-Click, MiniMap-Click, PREV/NEXT, ←/→-Shortcuts.

**Spectral Color-Tag (Phase D)**:
- `Polaroid.tsx`: 3px stripe rechts am Image-Well, `mask-image` linear-gradient für sanftes top/bottom fade-out.
- `Frame.tsx`: 6×6 Mini-Dot in der Bottom-Label-Band (zwischen `#NN` und `Nbr·bars`), 0.5px black rim für Lesbarkeit.

**Shortcuts (final, in `ArrangeTransport.tsx`)**:
- Space → play/pause
- ←/→ → focus prev/next + seek (vorher: cursor nudge)
- ⇧←/⇧→ → move focused frame (vorher: focus prev/next)
- Backspace → drop focused
- D → duplicate focused (vorher: ⌘D)

**Click-Verhalten ist global state-erhaltend**: Frame-Click, MiniMap-Click, Polaroid-Click, Spectrogram-Click, PREV/NEXT — keiner setzt `setPlaying(true)`. Pause-State bleibt Pause-State, Play-State läuft an der neuen Position weiter. Einziger Trigger zum Start-of-Playback: Play-Button + Space.

**MiniMap (`MiniMap.tsx`)**:
- Click-on-Tick hit-tested gegen `data-strip-frame-id`-Cousin: pickt das richtige Item, ruft `seekToItem(id)`. Drag scrollt weiterhin den Strip. Falls in der Lücke geklickt: nur Scroll, keine Selektion.
- Focused-Color hot-orange (vorher cobalt) — synchron zum neuen Frame-Bezel.

**Thumbnail-Quality-Fix (`chunk-thumbnails.ts`)**:
- Tier-2 Slice produziert jetzt JPEG in **nativer Tile-Resolution** (kein 1.4–4× Upscale-then-recompress mehr), JPEG-Quality 0.9.
- `TIER2_MIN_TILE_WIDTH = 100` — wenn der Tile in Display-Orientierung schmaler als 100px ist (typisch portrait phone clips mit ~45px Tile-width), Tier-2 wird übersprungen → Tier-3 (full-res Video-Seek) liefert ein sauberes Thumbnail.
- Tier-3 `THUMB_WIDTH = 256` (vorher 200).
- IDB v6 → v7 mit auto-clear vom `chunk-thumbnails` Store, sonst sähe der User die alten blocky Versionen weiter.

**Tailwind tokens** (`tailwind.config.js`): Neue keyframes `cockpit-scan`, `frame-pulse`. Animations `animate-cockpit-scan` (4s linear infinite, momentan ungenutzt nachdem der Mel-Playhead synchron läuft), `animate-frame-pulse` (1.6s ease-in-out infinite). `phosphor-text` utility class in `styles.css` (color #FF8A4F + dual text-shadow glow).

**Storage-Schema-Änderungen**:
- IDB v5 → v6: neuer `chunk-mel-specs` Store (key `${jobId}::${chunkId}`, value `{data, nMels, nFrames, durationS, chroma?}`). Migration ist additiv, kein clear.
- IDB v6 → v7: clear `chunk-thumbnails` Store (slicer-quality fix invalidates all old).
- `jobsDb.getChunkMelSpec`, `saveChunkMelSpec`, `deleteChunkMelSpecsForJob` als Public API.

### Phase 6 — Editor Multi-Pill-Refactor 🚧 not started

Siehe Datenmodell oben. Großer Brocken — `clips[]` → `lanes[].pills[]`, Selection-Refactor, Cuts-Logik anpassen, PreviewRuntime + VideoElementPool refaktorieren, schema migration. Phase 7 Wiring funktioniert auch ohne, also bewusst rausgeschoben — beim Start mit dem User klären ob's noch gebraucht wird.

---

### Phase 7 — Send to Editor + Segment Playback ✅ wiring done, ungeprüft

`arrangementToSegments()` baut die Segment-Liste aus dem Arrangement. Editor's `useAudioMaster` walked sie per gapless crossfade-hop. E2E-Test (`scripts/arrange-e2e-screens.mjs`) propagiert 21 segments durch — vom User noch nicht durchgespielt.

---

### Phase 8 — Polish 🚧 not started

Sensitivität (snap-tick-feedback, nudge-haptic), performance (4h profile), settings persistence, README docs.

---

## Critical Files Reference

**Read first** beim Wiedereinstieg:
- `frontend/src/storage/jobs-db.ts` — Persistenz-Schema (Chunk, ArrangementItem, LocalJob, VideoAsset.framesOrientation, ChunkMelRecord, IDB v7)
- `frontend/src/local/jobs-routing.ts` — `nextRouteForJob()`, `jobRoutePath()`
- `frontend/src/local/triage/triage-store.ts` + `src/local/arrange/arrange-store.ts` — Store-Patterns (arrange-store hat jetzt analysis/melByChunkId/seekToItem)
- `frontend/src/components/CamPickerDropdown.tsx` — shared cam-picker für Triage + Arrange
- `frontend/src/components/triage/TriageTransportBar.tsx` — Transport-Pattern (centered grid, `useRegisterShortcut`)
- `frontend/src/local/arrange/chunk-thumbnails.ts` — 3-tier thumbnail resolver, rotation-aware, Tier-2-Threshold
- `frontend/src/local/arrange/chunk-mel.ts` — auto-tags / spectral-color / stems-heuristik / keyFromChroma helpers
- `frontend/src/local/arrange/useChunkMelSpecs.ts` — Lazy-eager pipeline (PCM-decode + worker)
- `frontend/src/components/arrange/PlayerCockpit.tsx` — OP-1 Phosphor LCD, click-to-seek im Spektrogramm
- `frontend/src/components/arrange/useArrangeAudio.tsx` — Walker-based audio master (NICHT mehr time-match!)
- `frontend/src/local/render/frames/{webcodecs,ffmpeg,index}.ts` — Strip-Extraktion mit `rotationDeg`
- `frontend/src/editor/components/{BpmReadoutView,TransportClockView,SnapModeButtonsView,ChunkyButton,HardwarePopover,icons}.tsx` — design-tokens (ChunkyButton.children jetzt optional)
- `frontend/src/editor/shortcuts/useRegisterShortcut.ts` — Shortcut-Registry-Pattern
- `frontend/wasm/sync-core/src/mel.rs` + `chroma.rs` + `lib.rs` — WASM exports `melSpectrogram`, `chromaProfile`

Allgemein wichtig:
- `frontend/src/editor/store.ts` — Editor-Zustand (für Phase 6+7)
- `frontend/src/editor/useAudioMaster.ts` — gapless audio crossfade pattern
- `frontend/wasm/sync-core/src/silence.rs` — Silence detection

---

## Verification Strategy

- **Unit-Tests** pro Phase, TDD red→green→refactor.
- **Browser-Tests** (`bun x vitest run --project=browser`) für Pipelines mit synthetischem PCM (siehe `chunk-detect.browser.test.ts` als Vorbild).
- **E2E mit Playwright**: Upload → Triage → Arrange → Editor → Render-Spec.
- **Manueller Audio-Test** für gapless playback paths.
- **Real-Footage-Test** ab Phase 5: User stellt 1h+ Session zur Verfügung.
- **Memory-Profil** pro Phase mit Chrome DevTools, Constraint: < 300 MB Heap auch bei 4h-Sessions.

---

## Risiken / Open Items

1. **Multi-Pill-Refactor (Phase 6) ist die invasivste Änderung** — könnte schmerzen. Mitigation: extensive existierende Tests vorab grün, dann inkrementelle Migration.
2. **Drag-Reorder in Arranger könnte Crossfade-Punkte hörbar machen wenn BPMs nicht matchen** — eigentlich gelöst durch globalen BPM-Wert, aber: wenn User manuell BPM per Job setzt der nicht zu allen Chunks passt, gibt's Tempo-Sprünge zwischen Chunks. UI-Warnung könnte sinnvoll sein.
3. **`audioStartMs` für kurze Chunks fehlt** (Onset-Detection skipped bei < 4s) — dort wird auf `startMs` zurückgegriffen, was die silence-Boundary ist (nicht ein musikalischer Downbeat). Bar-Grid ist dann minimal off. Akzeptiert für jetzt.
4. **Sync-Nudging gibt's nur noch im Editor** — Triage hat keinen SyncPatch mehr. Wenn ein Cam falsch synct ist, muss der User nach „Continue → Arrange" weitergehen und im Editor nudgen. Vom User akzeptiert.
5. **Legacy-jobs ohne `framesOrientation`** — laufen über den manuellen Rotations-Pfad in `chunk-thumbnails.ts`. Wenn Phase 6 / 7 sauber läuft, lohnt sich evtl. ein Migration-Tool das alte Strips re-extrahiert. Bisher kein Druck.

---

## Lessons (evergreen — relevant für jede zukünftige Session)

- **Editor maximal recyceln über Props-getriebene `<View>`-Twins.** Editor-Komponenten sind store-gekoppelt. Lösung: `View`-Variante extrahieren (presentational), Editor mountet store-bound Wrapper, neue Surfaces mounten View direkt mit eigenem Store. Pattern: BpmReadoutView, TransportClockView, SnapModeButtonsView, CamPickerDropdown.
- **Filter sind View-Schicht, mutieren nicht Daten.** Min-Bars-Filter ist ein Predicate (`chunkPassesFilter()`), AND mit `chunk.accepted` zur Render-Zeit. User-Decisions bleiben unangetastet, Filter ist reversibel.
- **Adaptive Marker-Density ist Pflicht.** Power-of-2-Stride mit `TARGET_LABEL_PX = 56` als untere Schranke. Plus Sub-Beat-Ticks (1/8, 1/16) ab gewisser Beat-pixel-density.
- **Bar-Ruler in der Triage zeigt NUR den fokussierten Chunk.** Bar-Grid ist per-Chunk-Context, nicht Page-Context — sonst Chaos bei vielen Chunks.
- **Snap-Bypass = Shift, NICHT Alt.** NLE-Standard.
- **Page muss `h-screen` sein, nicht `h-full`** wenn Parent `min-h-full` setzt — sonst greift `flex-1` nicht.
- **Shortcut-Registry ist global** (`editor/shortcuts/registry.ts`) — `useRegisterShortcut()` registriert in einem app-weiten Store, `<HelpOverlay />` sammelt alle.
- **Diagnose-Logging hinter localStorage-Flag** statt console-spam. `localStorage.__thumbDebug = '1'` schaltet pro Surface ein/aus. Hilft beim debuggen ohne Production zu verseuchen.
- **Race-prone Probe-Caches deduplizieren** über `Map<key, Promise<T>>`, NICHT `Map<key, T>` — concurrent calls warten dann auf dasselbe in-flight build statt jeder seine eigene Probe zu starten.
- **Bei rotation-relevanten Pipelines**: rotation einmal beim Encode anwenden, nicht bei jedem Consumer separat. Schema-Flag (`framesOrientation`) markiert Container-Eigenschaften, nicht den Verbraucher.
- **Diagnostiziere bevor du fixst.** Theoretische Mechanismen wie „Race condition zwischen X und Y" sind keine Diagnose, das ist Spekulation. Schreib Logs, lass den User reproduzieren, sammle Daten, DANN fix.
- **Wenn der User „Bug X tritt auf" sagt, glaub ihm.** Nicht weg-analysieren, nicht „hast du IDB clear gemacht?" — der hat fresh-from-scratch getestet.

---

## Next Session — Quick Briefing

**Stand**: Phase 5 + 5b vom User abgenommen ("Perfekt. Danke für die Arbeit. Ist nen tolles Modul geworden."). Arrange-Screen ist optisch + funktional fertig: OP-1 Phosphor Cockpit, Mel-Spec mit click-to-seek, Auto-Tags (KEY/DENS/BRGT/PEAK), Stem-Bars, Spectral Color-Tag, skeuomorpher Frame-Bezel, Walker-basierte gapless playback (kein Duplicate-Loop mehr), MiniMap-Click→select, Click-never-changes-playstate als globale Regel.

**Was als nächstes anstehen könnte**:

1. **Phase 7 E2E vom User durchspielen lassen** — Continue→Editor mit echtem long-form-job. Hört er die Segment-Boundaries sauber? Knackt's an den Crossfade-Hops im Editor? `useAudioMaster.ts` (Editor) ist hot spot. Beachte: der **Arrange**-Audio-Master nutzt jetzt einen Walker (currentItemId als state), der **Editor**-AudioMaster nutzt vermutlich noch das alte Pattern — bei Phase 7 E2E darauf achten ob duplicate-segment-Loops dort wieder auftreten würden, dann Walker-Refactor dort wiederholen.
2. **`window.__lastEditorSegments`** — falls Phase 7 abgenommen ist, das Test-Hook entfernen oder via env-flag gaten.
3. **Phase 6 Multi-Pill-Refactor** klären: User wollte das mehrfach offen lassen — beim Start fragen ob das überhaupt noch gewünscht ist. Wenn nicht → Phase 6 raus aus dem Plan, direkt zu Phase 8 Polish springen.
4. **KEY-Detection-Robustheit**: aktuell läuft sie über das gesamte chunk-PCM und schreibt manchmal nonsense bei reiner Drum-Loops (kein klarer harmonischer Inhalt). Wenn der User das stört: Threshold einführen — KEY zeigt nur dann eine Tonart wenn das chroma-Spitzen-Verhältnis (peak/mean) über z.B. 1.5 liegt, sonst "—". Helper liegt in `chunk-mel.ts:keyFromChroma`.
5. **Stem-Bars-Kalibrierung**: heuristisch in `chunkStemHeuristic`, getuned gegen Bauchgefühl. Wenn der User auf seinen echten Sessions einen Bias spürt (z.B. "BASS zeigt immer 80%"), Schwellwerte dort drehen — Konstanten heißen `kickStrength`, `hatStrength`, `bassSus`, `formantBand` etc., alle clamped 0..1.

**Workflow-Reminder**:
- WASM `pkg/` ist gitignored → nach Pull `bun run wasm:build` aus `frontend/`.
- Tests: `bun x vitest run --project=unit` für unit, `--project=browser` für browser-tests (Chromium). Mel-tests: `cd frontend/wasm/sync-core && cargo test mel`.
- Worktree lebt in `.claude/worktrees/{name}/` — bash cwd resettet zwischen calls, mit absoluten Pfaden arbeiten oder `cd && cmd` chainen.
- Diagnose-Logging: `localStorage.__thumbDebug = '1'` in der Console aktiviert die Tier-Resolver-Logs.
- IDB-Schema steht jetzt bei v7. Beim Hinzufügen neuer Stores: nicht vergessen `deleteJob` und `wipeAll` zu erweitern.

**Letzte UX-Konventionen (in dieser Session etabliert, beim Bauen weiterer Surfaces honorieren)**:
- **Click ändert nie den Play-State.** Pause bleibt Pause, Play bleibt Play. Einziger Trigger: Play-Button + Space.
- **`seekToItem(itemId)`** ist die kanonische Action für "User picked this item" — focus + currentItemId + seek in einem move. Frame-Click, MiniMap-Click, PREV/NEXT, ←/→ alle gehen darüber.
- **Walker statt Time-Match** im Audio-Master: bei Duplikaten (gleiche chunkId mehrfach im arrangement) muss der walker explicit advance, sonst loop.
- **Native Tile-Resolution** beim Strip-Slice. Kein Upscale-then-recompress. Bei zu kleinen Tiles (portrait phone clips < 100px display-width) → Tier-3 fallback.
- **Hot-Orange #FF5722** ist die Selection-Farbe (vorher cobalt). Frame-Bezel + MiniMap-Tick + Cockpit-Glow alle aufeinander abgestimmt.
- **Phosphor-Glow** für alles was "lit" sein soll: text-shadow `0 0 6px rgba(255,138,79,0.7), 0 0 12px rgba(255,87,34,0.3)`. Utility-Class `phosphor-text` in styles.css.
