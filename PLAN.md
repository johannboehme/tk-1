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
- **Arrange**: User sortiert die akzeptierten Chunks per Mini-Arranger, kann duplizieren.
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

// LocalJob extension (existiert bereits, hier zur Vollständigkeit)
interface LocalJob {
  // ...
  mode: JobMode;
  silenceConfig?: SilenceConfig;
  /** Song-globale Tempo-Quelle. Wird beim Sync via pickGlobalBpm
   *  geschrieben (manualOverride: false), User-Edits setzen
   *  manualOverride: true. */
  bpm?: { value: number; confidence: number; phase: number; manualOverride?: boolean };
  beatsPerBar?: number;           // default 4
  barOffsetBeats?: number;        // anacrusis, default 0
  ui?: { snapMode?: SnapMode; lanesLocked?: boolean };
  chunks?: Chunk[];
  arrangement?: ArrangementItem[];
  triageEnvelope?: Float32Array;  // 10 Hz RMS, cached so Triage opens instant
  // sessionBpmOverride existiert noch im Schema, ist aber deprecated
  // — durch job.bpm.manualOverride abgelöst.
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
| 5. Arrange Phase | ⚠️ in progress, **NICHT abgenommen** | UI gebaut (Filmstreifen + Polaroid Contact-Sheet + LCD-Cockpit), aber Thumbnail-Pipeline + Rotation noch buggy. **Siehe Status-Section unten BEVOR du irgendwas anfasst.** |
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
   - Cam Preview (1.5fr, `aspect-video`, Cam-Picker-Dropdown im Corner-Badge)
   - Inspector (1.1fr, `BpmReadoutView` im Header, KV-Grid + Trim-by-bar im scrollable Body)
   - ChunksList (0.6fr, kompakte Rows mit `from → to` + Länge + DROP/FILT-Badges)
3. **DeckStrip** (h-20, brushed-metal) — `SnapModeButtonsView` (cassette-Plate, ohne MATCH) + Detection-Sliders + `MIN`-Filter-LCD + `KEPT`-Counter-LCD
4. **Timeline** (flex-none, h-188, full width) — siehe TriageTimeline unten
5. **TransportBar** — 3-col grid: Clock (links), Buttons-Cluster (zentriert: Prev/Play/Next │ Keep/Drop │ Loop), Counter-Reserve-Spalte (rechts, dient als Footer-Overlay-Clearance)

Page wrapper ist `h-screen overflow-hidden` damit ControlRow's flex-1 wirklich auf Viewport-Höhe greift und ChunksList intern scrollt.

**TriageTimeline (`src/components/triage/TriageTimeline.tsx`):**
- Vier Layer übereinander: Time-Ruler (16px, secondary, 8px font, faint stone) | Bar-Ruler (30px, primary, hot-color, numbered downbeats) | Waveform (Canvas2D, max 110px) | Chunk-Lane (32px)
- **Bar-Ruler zeigt nur den fokussierten Chunk** (sonst Ruler-Chaos bei vielen Chunks). Anchored an `chunk.audioStartMs`, gestepped mit `job.bpm`. Extension-Ticks (außerhalb der Chunk-Bounds, fürs Trim-Drag-Snap-Preview) gedimmt.
- **Adaptive Density** (zoom-abhängige Stride):
  - `bar-major` (2px voll, mit Bar-Number-Label) — power-of-2 stride so dass Labels ≥ 56 px auseinander
  - `bar-minor` (1.5px, 70% Höhe) — bei stride > 1, ab `pxPerBar ≥ 6`
  - `beat` (1px, 40%) — bei stride === 1, ab `pxPerBeat ≥ 8`
  - `div8` (1px, 25%) — ab `pxPerBeat ≥ 32`
  - `div16` (1px, 15%) — ab `pxPerBeat ≥ 64`
- **Pointer-Interaktion**:
  - Wrapper-`onMouseDown`: Click in Chunk-Lane auf Chunk → focus (kein Seek). Click in Waveform-Y-Range auf Chunk → focus + Playhead-Seek. Click in Time/Bar-Ruler → nur Seek.
  - Playhead-Drag: nach mousedown weiter scrubben mit Snap (Snap-Context = Chunk unter Cursor, fallback focused).
  - Trim-Drag: per-Chunk Edge mit `data-trim-handle` Attribute, e.stopPropagation(), eigenes drag-state. Snap nutzt `chunk.audioStartMs` als beatPhase, `job.bpm` als step, `snap.snapTime()` aus `editor/snap.ts`.
- **Snap-Bypass**: Shift, NICHT Alt (NLE-Konvention).
- Mouse-Wheel = zoom anchored am Cursor. Pinch + 1-finger-pan auf Touch.
- Chunk-Block-Width matcht reale Dauer (kein min-clamp); kein "●"/"✕" Zwischenstufe — entweder voller Readout (≥120px) oder nur Background-Color.

**TransportBar (`src/components/triage/TriageTransportBar.tsx`):**
- Editor's `TransportClockView` reused (lokaler `TriageClock` wrapper subscribt nur currentTime, damit der Rest der Bar nicht 60×/s rerendert)
- Loop-Toggle ganz rechts im Cluster (rare-action-Position), Shortcut `L`
- `focusRelative(±1)` walkt **effektiv-akzeptierte** Chunks (Filter + accepted) — Prev/Next + Shift+←/→ skippen sowohl gedroppte als auch gefilterte

**Inspector (`src/components/triage/ChunkInspector.tsx`):**
- Header: Title + Index + `BpmReadoutView` (brass-plate, ÷2/×2-Hardware-Keys im Edit-Mode)
- Body (scrollt wenn nötig): KV-Grid (In/Out/Length/Bars/Anchor) + Trim-by-bar 2×2 Buttons (`extendChunkBars` snappt aufs Chunk-Grid bevor's steppt)
- Kein Keep/Drop, kein Per-Chunk-Octave-Shift (BPM ist global)

**DetectionPanel (`src/components/triage/DetectionPanel.tsx`):**
- Threshold + Min-Pause Slider (live re-detection auf cached envelope, 50ms debounce)
- `MIN`-Filter (brass-bezel + LCD): klick-to-edit Number-Input (freier Integer 0-999, 0 = OFF, mint wenn off, amber wenn aktiv). Reine View-Schicht — `chunkPassesFilter()` Predicate, mutiert `chunk.accepted` NICHT, ist reversibel.
- `KEPT`-Counter (brass-bezel + LCD, paired layout): zählt effektiv-akzeptierte (accepted ∧ passesFilter) + summed duration

**ChunksList (`src/components/triage/ChunksList.tsx`):**
- Kompakte 28px-Rows: Index + `from → to` + Länge + DROP/FILT-Badge
- Click-to-focus only, kein inline Keep/Drop

**CamPreview (`src/components/triage/CamPreview.tsx`):**
- Cam-Label im Corner ist ein Dropdown — listet alle Cams, click switcht
- Hidden video element, seekt zu `currentTime - syncOffsetMs/1000`
- Per-Cam Sync-Nudging gibt's hier NICHT (im Editor wo Cuts dranhängen)

**TriageAudioMaster (`src/components/triage/useTriageAudio.tsx`):**
- Dual-element ping-pong, 8ms WebAudio gain-crossfade, 50ms lead — gapless loop
- Respektiert `playback.loopEnabled` (default true): off → linear playback, focus-Click jumpt nur zum Chunk-Start

**useTriagePersist (`src/local/triage/useTriagePersist.ts`):**
- Debounced 250ms IDB write für: chunks, silenceConfig, jobBpm (→ `job.bpm`), beatsPerBar, snapMode (→ `job.ui.snapMode`, shared mit Editor), per-cam syncOverrideMs

**Help-Overlay**: `<HelpOverlay />` ist global in `App.tsx` gemountet, "?"-Key + `?`-Button im PhaseStrip dispatcht synthetisches keydown. TransportBar registriert via `useRegisterShortcut`: Space, Shift+←/→, Enter, Backspace, L.

**Continue → Arrange**: Seedet `arrangement` mit effektiv-akzeptierten Chunks (chronologisch). Re-Entries fügen nur neue Chunks hinzu, behalten User-Sortierung.

**Files**:
- `src/pages/Triage.tsx`
- `src/local/triage/triage-store.ts`, `useTriagePersist.ts`
- `src/components/triage/TriageTimeline.tsx`, `TriageTransportBar.tsx`, `DetectionPanel.tsx`, `ChunkInspector.tsx`, `ChunksList.tsx`, `CamPreview.tsx`, `useTriageAudio.tsx`
- Shared View-Components (extrahiert aus Editor): `src/editor/components/BpmReadoutView.tsx`, `SnapModeButtonsView.tsx`, `TransportClockView.tsx`

---

### Phase 5 — Arrange Phase ⚠️ in progress, **NICHT vom User abgenommen**

**Designkonzept (vom User in dieser Session abgenickt)**: 35mm-**Filmstreifen** mit Sprocket-Holes als zentrale Komponente. Polaroid-Contact-Sheet als Source-Pool drunter (heißt im Header schlicht „Chunks · N"). Player-Cockpit oben mit kleiner Cam-Vorschau + dunklem LCD (TOTAL · NOW · ITEM · BPM). Insertion-Cursor zwischen Frames als universelle Add-Mechanik (statt Drag&Drop-only). Inspector inline in der Bottom-Transport-Bar. Mini-Map nur bei Strip-Overflow. Default-Arrangement = 1:1 chronologisch aus Triage-akzeptierten Chunks; User kann direkt **Continue → Editor** klicken ohne irgendwas anzufassen.

**Was umgesetzt ist**:

- `src/local/arrange/`:
  - `arrange-store.ts` — zustand store mit `arrangement[]`, `chunks[]`, `cams[]`, `focusedItemId`, `insertionIndex`, `selectedCamId`, `playback`, `view`, `jobBpm`, `jobBeatsPerBar`. Actions für insertChunkAtCursor / removeItem / shiftItem / reorderItem / duplicateItem / focusItem / focusRelative / setSelectedCamId / setPlaying / seek / tickTime / setStripScrollPx / setStripMetrics. `frameWidthForBars(bars)` — sublineares sqrt-scaling 64–200 px. `effectiveBarsForChunk(chunk, jobBpm, jobBeatsPerBar)` — song-global BPM driven, NICHT per-chunk.
  - `useArrangePersist.ts` — 250ms debounced IDB write für arrangement + cam syncOverrideMs.
  - `chunks-to-segments.ts` — `arrangementToSegments(arrangement, chunks)` mappt nach `EditSpec.segments[]`. Tests grün.
  - `chunk-thumbnails.ts` — **3-tier thumbnail resolver** (siehe Bug-Section unten).

- `src/components/arrange/`:
  - `FilmStrip.tsx` — Hauptkomponente. Sprocket-Hole-Rails oben/unten, Frame-Reihe in der Mitte, length-proportional Frames, drag-on-frame-to-reorder, Insertion-Cursor zwischen jedem Frame, Right-click = remove.
  - `Frame.tsx` — Einzelner Strip-Frame; Cam-Color-Stripe unten, focused = cobalt outline, current playing = top-LED. IntersectionObserver-gated thumbnail load via `useChunkThumbnail`.
  - `ContactSheet.tsx` — Wrap-grid (kein horizontal-scroll), label "Chunks · N", scrollt intern. Composiert Polaroid pro chunk.
  - `Polaroid.tsx` — Polaroid-card mit Develop-Animation (saturate/sepia → full color über 800ms), `+ ADD` button = insert at cursor. Tap body = focus + preview-loop.
  - `InsertionCursor.tsx` — Glühende vertikale Linie zwischen Frames, click setzt insertionIndex.
  - `MiniMap.tsx` — Overflow-only; cobalt highlight für focused, hot-orange für playing.
  - `PlayerCockpit.tsx` — Cam-Sucher (links) + Dark-LCD (TOTAL/NOW/ITEM/BPM/REC).
  - `CamPreviewArrange.tsx` — Hidden video, seekt zu master-time minus cam-syncOffset, cam-picker als ◀cam-X▶ am unteren Rand. Sm: square 84×84, sm+: 240×135.
  - `ArrangeTransport.tsx` — Bottom bar; PREV/PLAY/NEXT + ◀cur/cur▶ + Inspector inline (FRAME N/M, bars, ◀ ▶ Dup Drop) + 210px footer-clearance rechts.
  - `useArrangeAudio.tsx` — Sequenzielle gapless playback, dual-element ping-pong + 8ms WebAudio crossfade-hop am chunk-Ende zum next-chunk-start. Pattern aus `useTriageAudio` recycelt.

- `src/pages/Arrange.tsx` — `h-screen overflow-hidden` wrapper (Triage-Pattern), full-width single-column layout. `prefetchChunkThumbnails()` lädt IDB-cached thumbs in memory beim Mount. `continueToEditor()` flusht arrangement synchron in IDB bevor er navigiert (sonst geht der Persist-Debounce verloren).

- **Phase 7 wiring** parallel mit gemacht (kein eigener Editor-Refactor, einfach segment-walker eingebaut):
  - `editor/store.ts` bekommt `arrangementSegments: Segment[]` field + `setArrangementSegments` action; `loadJob` opts erweitert; `buildEditSpec` emittiert die Segmente verbatim wenn non-empty (Renderer kann schon multi-segment).
  - `editor/useAudioMaster.ts` segment-walker branch: gapless hop von segment N's `out` zu segment N+1's `in` via wrapTarget auf der existierenden Crossfade-Maschine. Last segment → pause statt loop.
  - `editor/components/Timeline.tsx` dimmt off-segment Regionen auf der Audio-Lane + zeichnet hot splice marks an Boundaries.
  - `pages/Editor.tsx` ruft `arrangementToSegments(j.arrangement, j.chunks)` und übergibt an loadJob; trim spannt min/max aller segments.
  - Editor exposed `window.__lastEditorSegments` als E2E-debug-hook (Vite dev hands distinct module instances zurück für dynamic imports vs static).

- **VideoAsset.intrinsicRotationDeg**: neues Feld, populated beim Sync von `info.rotationDeg` aus dem demuxer. Für Legacy-Assets ohne das Feld macht der thumbnail resolver einen lazy demux probe + persistiert zurück. Heuristik (dim-swap = 90°) als allerletzter Fallback.

- **IDB schema**: v3 → v4 (`chunk-thumbnails` store) → v5 (auto-clear chunk-thumbnails on migration weil rotation-pipeline sich geändert hatte).

**Schreib-/Architektur-Entscheidungen**:
- Inspector lebt **nicht** in einer Side-Bar sondern in der Bottom-Transport-Bar — User wollte expliziten Recovery von horizontalem Platz für Strip + Contact-Sheet.
- ContactSheet wraps statt horizontal-scroll → bei vielen chunks füllt das den verfügbaren vertikalen Platz, scrollt intern.
- `h-screen overflow-hidden` auf der Page (Triage-Pattern) damit `flex-1` die ContactSheet auf Viewport-Höhe constraint.

---

### Phase 6 — Editor Multi-Pill-Refactor 🚧 not started

Siehe Datenmodell oben. Großer Brocken — `clips[]` → `lanes[].pills[]`, Selection-Refactor, Cuts-Logik anpassen, PreviewRuntime + VideoElementPool refaktorieren, schema migration.

---

### Phase 7 — Send to Editor + Segment Playback 🚧 not started

`chunksToEditSpec()` baut Multi-Pill-EditSpec aus arrangement. Editor's useAudioMaster bekommt segment-handoff (Hop von Segment-Ende zum nächsten Segment-Start via gapless crossfade). Roundtrip Triage→Arrange→Editor→zurück preserved Edits per stable IDs.

---

### Phase 8 — Polish 🚧 not started

Sensitivität (snap-tick-feedback, nudge-haptic), performance (4h profile), settings persistence, README docs.

---

## Critical Files Reference

**Read first** für Phase 5 (Arrange):
- `frontend/src/storage/jobs-db.ts` — Persistenz-Schema (`Chunk`, `ArrangementItem`, `LocalJob.arrangement`)
- `frontend/src/local/triage/triage-store.ts` — Pattern für Page-Store + Persist-Hook
- `frontend/src/components/triage/TriageTransportBar.tsx` — Transport-Pattern (centered grid, Help-button, useRegisterShortcut)
- `frontend/src/pages/Triage.tsx` — h-screen rack-Layout + PhaseStrip
- `frontend/src/editor/components/BpmReadoutView.tsx`, `TransportClockView.tsx`, `SnapModeButtonsView.tsx` — wiederverwendbare TE-Komponenten
- `frontend/src/editor/components/ChunkyButton.tsx`, `HardwarePopover.tsx`, `icons.tsx` — design-tokens
- `frontend/src/editor/shortcuts/useRegisterShortcut.ts` — Shortcut-Registry-Pattern

Allgemein wichtig:
- `frontend/src/editor/store.ts` — Editor-Zustand (für Phase 6+7)
- `frontend/src/editor/useAudioMaster.ts` — gapless audio crossfade pattern
- `frontend/src/local/render/audio-analysis/analyze.ts` — BPM/Onset
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
4. **Sync-Nudging gibt's nur noch im Editor** — Triage hat keinen SyncPatch mehr. Wenn ein Cam falsch synct ist, muss der User nach „Continue → Arrange" weitergehen und im Editor nudgen. Ist das ein Problem? User sagt: nein, im Editor passt's.

---

## Lessons aus dem Triage-Bau (memory für die nächste Session)

- **Editor maximal recyceln über Props-getriebene `<View>`-Twins.** Editor-Komponenten sind store-gekoppelt — direkt-recyceln geht nicht. Lösung: `View`-Variante extrahieren (presentational, props-driven), Editor mountet store-bound Wrapper, neuer Surface mountet `View` direkt mit eigenem Store. Pattern für Phase 5: BpmReadoutView, TransportClockView, SnapModeButtonsView gibt's schon — genauso für jeden weiteren Reuse vorgehen.
- **Filter sind View-Schicht, mutieren nicht Daten.** Min-Bars-Filter bei mir war initial ein Mutation-Step (`accepted = false` für kurze Chunks). User hatte recht: irreversibel. Lösung: Predicate `chunkPassesFilter()`, AND mit `chunk.accepted` zur Render-Zeit. Filter ist reversibel, User-Decisions bleiben unangetastet.
- **Adaptive Marker-Density ist Pflicht.** Initiales Bar-Ruler-Design hat alle Bars gleichzeitig gerendert → bei vielen Chunks oder Low-Zoom unleserliche Wand. Power-of-2-Stride mit `TARGET_LABEL_PX = 56` als untere Schranke. Plus Sub-Beat-Ticks (1/8, 1/16) ab gewisser Beat-pixel-density.
- **Bar-Ruler in der Triage zeigt NUR den fokussierten Chunk.** Long-form mit 78 Chunks und jeder labelt sein "1" am Anchor → Chaos. Bar-Grid ist per-Chunk-Context, nicht Page-Context. Andere Chunks sind als Lane-Blöcke unten sichtbar — das reicht.
- **Snap-Bypass = Shift, NICHT Alt.** Editor hat das so (NLE-Standard, `Timeline.tsx:768`). Triage zog erst Alt → falsch.
- **Chunk-Marker-Width muss reale Dauer matchen.** `Math.max(2, ...)` clamp lügt visuell — kurze Chunks erscheinen größer als sie sind. Sub-pixel-Chunks dürfen verschwinden (ehrliche Antwort bei der Zoom-Stufe).
- **Page muss `h-screen` sein, nicht `h-full`** wenn Parent `min-h-full` setzt. Sonst greift `flex-1` nicht und alle „internal scrollers" (ChunksList) wachsen unbegrenzt.
- **Shared Snap-Helper: `editor/snap.ts`** — pure functions (`gridStepSeconds`, `snapTime`). Triage importiert direkt, kein Duplicate.
- **Shortcut-Registry ist global.** `useShortcutRegistry` (in `editor/shortcuts/registry.ts`), `useRegisterShortcut(...)` registriert in einem globalen Store, `<HelpOverlay />` ist app-weit gemountet, "?"-Key öffnet überall. Triage's TransportBar registriert seine Shortcuts → tauchen automatisch im Help-Panel auf. Für Arrange genauso.

---

## Status & Notes for Next Session — START HERE

**Letzter Stand: Arrange-UI gebaut, von der Bedienung her grob nutzbar, aber DIE THUMBNAIL-PIPELINE IST BUGGY und wurde vom User explizit NICHT abgenommen.** Du fängst nicht bei null an, aber renne nicht direkt weiter mit dem Code — lies erst die offenen Bugs unten.

### Offene Bugs (vom User in der letzten Session live festgestellt)

1. **Polaroid-Thumbnails sind teilweise um 90° rotiert** (manche, nicht alle).
   - **Test-Material**: `~/Downloads/test video.mp4` (rotation=+90 laut ffprobe).
   - **Was die letzte Session vermutet hat (und was sich als WAHRSCHEINLICH FALSCH herausstellte)**:
     - Theorie A: Stale IDB-Cache von vor dem Rotations-Fix. Schema-bump v4→v5 würde das self-healen.
     - Theorie B: dim-swap-Heuristik kann 90° nicht von 270° unterscheiden, also halbe Treffer.
   - **Was der User explizit gesagt hat**: „Das war kein IDB cache problem. Ich hab bei jedem versuch das Projekt komplett von 0 auf durchgeführt." Also frischer Job pro Versuch — kein stale cache.
   - **Echte Frage die NICHT beantwortet wurde**: Wenn alle Frames im selben Strip stecken, warum kommen manche korrekt rotiert raus und andere nicht? Möglichkeiten die NOCH nicht ausgeschlossen wurden:
     - Race condition zwischen `probe.rotationDeg`-Zuweisung und Tier-2-Slice-Aufrufen (mehrere Polaroids parallel mounten via IntersectionObserver — wenn die Promise-all-Sequenz nicht atomic ist, beobachten manche `rotationDeg=0`)
     - Tier-2 vs Tier-3 Mix: Tier-3 zieht Frame durch `<video>` (browser auto-rotates), Tier-2 zieht aus Strip (kein auto-rotate). Falls die Rotation-Probe nur für tier-2-Slices angewendet wird aber tier-3 ALS OB schon rotiert ist, könnte ein Subset doppelt-rotiert oder gar nicht rotiert werden.
     - Strip-Image hat wirklich uniformes Pixel-Layout aller Tiles — also kann's nicht "manche tiles rotated, manche nicht" am Quellbild liegen.
   - **Was nicht zu tun ist**: NICHT nochmal auf die "stale cache"-Theorie zurückfallen. NICHT den User fragen "hast du IDB clear gemacht". Der hat fresh-from-scratch getestet.
   - **Empfehlung**: Reproduce mit `~/Downloads/test video.mp4`, leg Logs in die Tier-Resolver, schau dir an WELCHE konkreten Polaroids gedreht sind (cam-id? chunk-zeit? tier?) und finde das Pattern bevor du irgendwas änderst.

2. **„no preview" (vorher „out of range") auf vielen kurzen Snippets**.
   - User hat gesagt die betroffenen Chunks sind NICHT outside cam range. Trotzdem failed Tier-3.
   - Was ich versucht hab: clamp `sourceTimeS` zu `[0, duration-0.05]` damit chunks außerhalb der cam-range zumindest einen boundary frame kriegen. Hat möglicherweise nichts gebracht weil die Chunks gar nicht outside-range waren — der echte Failure-Modus war anders.
   - Mögliche andere Ursachen die NICHT verifiziert wurden:
     - `<video>.duration` ist NaN weil die `loadedmetadata`-5s-Timeout vor metadata feuert (relevant für sehr große Files? `test video.mp4` ist 9 GB)
     - `seeked` event feuert nicht bei manchen Frames → 2s safety timeout läuft → drawImage zieht falschen Frame oder failt
     - Race zwischen `clearChunkThumbnails` (StrictMode unmount) und in-flight extractions → probe.video.src removed → drawImage tainted
   - **Empfehlung**: Diagnostic logs in `seekAndCapture` lassen + reproduzieren. Welche Chunks failen, was sagt `v.duration`, was passiert beim seek.

3. **Drei Lade-Punkte (developing dots) erscheinen kurz auf jedem Polaroid beim Pageload, auch wenn IDB-cached.**
   - Was ich versucht hab: Bulk-prefetch `prefetchChunkThumbnails(jobId, camId, chunkIds)` in Arrange.tsx + `peekChunkThumbnailUrl()` synchroner getter + `useChunkThumbnail` initialisiert state aus dem peek.
   - User hat danach NICHT explizit bestätigt ob's behoben ist — möglich dass das tatsächlich gefixed ist, möglich dass nicht.
   - **Empfehlung**: Verifizier visuell, ob der Flicker noch da ist. Wenn ja: schaue ob der prefetch wirklich VOR dem ersten Polaroid-Mount durch ist (möglich dass die Prefetch-Promise noch fliegt während die Polaroids schon mounten, weil sie via IntersectionObserver getriggert werden — könnte timing-sensitiv sein).

4. **„Out of range" war ein irreführendes Label**. Jetzt heißt es „no preview" mit Tooltip. Der User hat das nicht explizit kommentiert, also vermutlich OK. Bug 2 darunter ist davon unabhängig — die Extraktion failed wirklich, das Label ist nur korrekter benannt.

### Was funktional läuft

- **Layout**: full-width filmstrip + wrap-grid contact-sheet + inline inspector in der bottom bar. User hat nicht weiter dran rumkritisiert.
- **Mini-Map**: highlight für `focusedItemId` (cobalt) und `currentItemId` (hot orange) — vom User in dieser Session als "geht jetzt" implizit akzeptiert.
- **Insertion-Cursor + reorder + duplicate + drop**: keine Beschwerden.
- **Sequential gapless playback** in Arrange (`useArrangeAudio`): nicht vom User getestet kommuniziert.
- **Phase 7 wiring** (arrangementSegments → editor → useAudioMaster segment-walker → timeline shading): funktioniert in E2E (`scripts/arrange-e2e-screens.mjs` läuft sauber durch, 21 segments propagieren). Vom User noch NICHT durchgespielt.
- **Continue-Button-Flow**: arrangement wird vor Navigation synchron geflusht → editor öffnet mit korrekten segments.

### Lessons aus dem Arrange-Bau (Memory für die nächste Session)

- **Diagnostiziere bevor du fixst**. Ich habe 3+ Iterationen verbrannt mit Theorien (StrictMode race, stale IDB cache, dim-swap-Heuristik) ohne den Bug einmal sauber zu reproduzieren + zu instrumentieren. Der User hat mir am Ende explizit gesagt "du bist nicht mehr koherent" — weil ich Bullshit-Diagnosen geliefert habe. **Schreib Logs, lass den User reproduzieren, sammle Daten, DANN fix.** Theoretische Mechanismen wie "Race condition zwischen X und Y" sind keine Diagnose, das ist Spekulation.
- **Wenn der User klar sagt "Bug X tritt auf", glaub ihm**. Ich hab dem User mehrfach gesagt "das wird der IDB cache sein, lösch ihn manuell" — der User hatte aber von Anfang an sauber from-scratch getestet. Ich habe nicht zugehört.
- **Wenn du drei Bugs gleichzeitig fixt und keiner davon vom User verifiziert wurde, beweisen E2E-Tests gar nichts**. Die fixture-Videos im Repo sind landscape — die testen den Rotations-Pfad nicht. Die Test-Cams haben keinen sync-offset → testen nicht den out-of-range-Pfad realistisch.
- **Phase 6 ist NICHT umgesetzt**. Ich hab das übersprungen weil "Phase 7 wiring funktioniert auch ohne Multi-Pill-Refactor". Das ist eine valide Architektur-Entscheidung wenn der User damit OK ist, aber lass den User explizit entscheiden bevor du die zukünftige Multi-Pill-Welt aufgibst.
- **Editor exposes `window.__lastEditorSegments`** als Test-Hook. Das ist offen committed; entweder rausziehen wenn finalisiert oder dokumentiert lassen.

### Was committed ist (auf diesem Branch)

Tail nach `git log --oneline 8d8f02d..HEAD`:
- `feat(arrange): Filmstreifen — Phase 5 + 7` (initialer Wurf)
- `fix(arrange): single-mount layout, stable selectors, segment trim min/max`
- `fix(arrange): adapt to song-global tempo model + Continue→Editor flush`
- `feat(arrange): full-width layout + 3-tier thumbnail resolver + IDB cache`
- `fix(arrange): pin page to viewport + scroll chunks panel internally`
- `fix(arrange): apply intrinsic rotation in strip-slice + tier-3 cleanup`
- `fix(arrange): persist+probe intrinsic rotation, clamp tier-3, sync-peek thumb cache`
- `fix(arrange): self-heal stale thumbnail cache + honest empty-state label`

Alle commits pushed auf `claude/goofy-blackwell-f2eb00`. PR-fähig sind die ersten ~3-4; die letzten Rotations-/Cache-Fixes sind verdächtig (siehe Bug 1) und sollten **vor dem Mergen revisited** werden.

### So fängst du in der neuen Session an

1. **Lies diese ganze PLAN.md** — Tempo-Modell, Datenmodell, Triage-Architektur, Arrange-Architektur (Phase 5 oben), und vor allem die Bugs hier in dieser Section.
2. **Frag den User welche Bugs Priorität haben**. Vermutlich: Rotation zuerst, dann no-preview, dann developing-dots-Flicker.
3. **Reproduce vor Fix**. Lass den User dir konkret sagen welcher Polaroid welches Verhalten zeigt. Logs in den Tier-Resolver, ggf. ein in-page-debug-Overlay das pro Polaroid zeigt welcher Tier gegriffen hat.
4. **NICHT die alten Theorien aus dieser Session blind weiterverfolgen** — die haben sich nicht bewährt.
5. **Erst wenn die Thumbnail-Pipeline robust ist**, vom User Phase 5 abnehmen lassen, dann zu Phase 6/7 verfeinern oder nächstes Feature.

### Pre-existing Caveats

- **WASM `pkg/` ist gitignored** — nach jedem Pull `bun run wasm:build` aus `frontend/`
- **Tests**: `bun x vitest run --project=unit` für unit, `bun x vitest run --project=browser` für browser-tests (Chromium via Playwright)
- **Worktree-Setup**: Dieser Branch lebt in `.claude/worktrees/goofy-blackwell-f2eb00/`. PWD beim shell-cd beachten — manche Bash-Calls landen im Repo-Root statt frontend/
- **TypeScript-WASM-Errors** beim Typecheck (`Cannot find module sync_core.js`) sind pre-existing wenn pkg/ noch nicht gebaut wurde — `bun run wasm:build` fixt das
- **E2E-Skript** liegt in `frontend/scripts/arrange-e2e-screens.mjs`. Seedet einen long-form job aus den `__readme_fixtures__` (landscape!), exerciset Tier 2 + 3, screenshots in `frontend/e2e-screens/` (gitignored). NUTZT NICHT die echten Test-Videos aus `~/Downloads/`. Für Rotations-Reproduktion brauchst du die echten Test-Videos.
