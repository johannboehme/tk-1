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
| 5. Arrange Phase | 🚧 not started | **NÄCHSTE SESSION** |
| 6. Multi-Pill Editor Refactor | 🚧 not started | Großer Brocken |
| 7. Send to Editor + Segment Playback | 🚧 not started | Verbindet Arrange ↔ Editor; braucht Phase 6 |
| 8. Polish | 🚧 not started | Sensitivität, Performance, Documentation |

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

### Phase 5 — Arrange Phase 🚧 NÄCHSTE SESSION

**Ziel**: User sortiert akzeptierte Chunks via Mini-Arranger.

**Konzept-Skizze (vor Beginn vom User abnehmen lassen!)**:
- ArrangementTimeline: horizontale Flow von Chunk-Cards, click-to-focus, Reorder via Drag, ×2 Duplicate, ✕ Remove
- SourcePool: vertikale Liste der akzeptierten Chunks (= alle Triage-effektiv-akzeptierten), mit Add-Button + Usage-Count pro Chunk
- ArrangeTransport: play/pause + Item-Jump (Shift+←/→ vermutlich, kollidiert mit Triage nicht da andere Page)
- Keyboard-Shortcuts müssen DE-safe sein. User wollte explizit `J/K/A/D/Cmd+arrows` für später freihalten — vermutlich für den Editor.

**Reuse-Audit (vor UI-Design machen!)**:
- `BpmReadoutView` für song-global BPM display (gleicher value wie Triage)
- `TransportClockView` für die Transport-Bar
- `SnapModeButtonsView` für Snap (falls überhaupt nötig — Arrange operiert auf Chunk-Granularität, nicht Sub-Bar; wahrscheinlich überflüssig)
- `useShortcutRegistry` + `useRegisterShortcut` (in `App.tsx` via `<HelpOverlay />` global gemountet — Help-Button-Pattern aus Triage übernehmen)
- PhaseStrip aus Triage.tsx (gleiche Komponente, `phase="arrange"` setzen)
- CamPreview könnte sinnvoll sein (mit Cam-Picker), wenn User pro Item Cam-Wahl bestätigen will. Nicht mit-bauen wenn unklar.

**Audio-Playback**: Erstmal Loop-Preview eines fokussierten Items (gleiches Pattern wie Triage's `useTriageAudio`, eigener `useArrangeAudio`-Hook). **Sequentielle Wiedergabe** der gesamten Arrangement ist Phase 7.

**Files** (geplant):
- `src/local/arrange/arrange-store.ts`, `useArrangePersist.ts`
- `src/components/arrange/ArrangementTimeline.tsx`, `SourcePool.tsx`, `ArrangeTransport.tsx`, `useArrangeAudio.tsx`
- `src/pages/Arrange.tsx` (existiert als Placeholder)

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

**Letzter Stand: Phase 3 (Triage) ist vom User abgenommen und gemerged-ready.** Phase 5 (Arrange) ist die nächste Aufgabe.

### Was committed ist (auf diesem Branch, 31 Commits ahead of `main`)

```
8d8f02d feat(triage): help button in the phase strip
11df037 fix(triage): min-bars filter accepts arbitrary integers, label "MIN"
9647f45 fix(triage deck strip): kept counter and bars filter render as a matched pair
89e126f feat(triage): min-bars filter is reversible + drops MATCH snap + brass-LCD design
8ded5c4 feat(triage): prev/next chunk navigation skips dropped chunks
6391ae6 fix(triage timeline): chunk markers render at true width, drop dot fallback
633b5ea feat(triage timeline): clicking the waveform inside a chunk focuses it
b49710c feat(triage timeline): add 1/8 + 1/16 sub-beat tick subdivisions
3e244ea fix(triage timeline): bar ruler renders ONLY the focused chunk's grid
55cb900 feat(triage): adaptive bar markers, playhead drag, snap+seek, min-bars filter
feeb50c fix(triage timeline): drop the loud audio-start anchor markers
8e14058 fix(triage timeline): bar ruler primary + per-chunk audio-start anchor markers
08b8440 fix(triage): per-chunk snap math + extension bar markers during trim drag
a2b5337 feat(triage): reuse editor TransportClock + Loop button to far right
b04ba19 fix(triage): centered transport bar + drop redundant per-chunk octave block
080f920 fix(triage): lock page to viewport so ChunksList actually scrolls
0ea5e38 fix(triage): cam-overflow + slim timeline + cam-picker dropdown + chunk row from→to
0f71bac feat(triage): rack-mount layout, BPM widget in inspector header, octave keys in BPM editor
2d7f6b3 feat(triage): layout overhaul, snap toolbar, BpmReadout reuse, loop toggle
694fbe4 docs: add PLAN.md with phase status + next-session notes
3ecff51 fix(sync-panel): handle 'detecting-chunks' stage so master state doesn't drop
b82b15d fix(triage): routing graduates to arrange only via explicit Continue
5ab95ee fix(triage): detect chunks during sync, instant page open, no double-loading
554d847 feat(triage): finish UI — bar-snap trim, sync-nudge, session BPM, gapless audio
4ca5cd2 feat(triage): full UI v1 — timeline, transport, panels, list, cam preview
32bc4b3 refactor(sync): extract SyncPatchPanel from JobPage to shared component
a53b5d1 feat(triage): chunk-detection backend (WASM silence + per-chunk BPM)
9aafd41 fix(jobpage): hide Quick render for long-form jobs, keep it for direct
1fb545c fix(upload): mode cards read as buttons, not drop targets
104d708 fix(triage): full-bleed layout, sync-first flow, simpler routing glyph
72cb6a5 feat(triage): mode-aware upload + triage/arrange route scaffolding
```

### So fängst du in der neuen Session an

1. **Lies diese PLAN.md durch** — alle Schlüssel-Entscheidungen, das Tempo-Modell, das Datenmodell, die Triage-Architektur, die Arrange-Konzept-Skizze, die Lessons.
2. **Reuse-Audit** für Arrange (siehe Phase 5 oben). Welche Editor- + Triage-Komponenten kommen ungenutzt rüber? Welche brauchen einen `View`-Twin?
3. **Layout-Konzept beim User abnehmen lassen BEVOR Code geschrieben wird** (Memory `feedback_design_iteration.md`). Frontend-Design Skill nutzen für die Konzept-Iteration.
4. **Dann erst implementieren.** TDD wo sinnvoll (Memory `feedback_tdd.md`). Multi-step plans ohne Pause durchziehen, commit OK, push nur auf Ansage (Memory `feedback_autonomous_execution.md`).
5. **Dev-Server starten am Session-Ende** + konkrete Test-Anleitung (Memory `feedback_dev_server_at_session_end.md`).

### Wichtige Vorgaben für Arrange

- **Keep/Drop-Aktionen sind wieder Triage** — Arrange-Items sind ja schon akzeptiert. In Arrange geht's nur um Reihenfolge + Duplikate + Remove (≠ Drop).
- **Reorder-Pattern**: Drag oder Up/Down-Arrows. User wollte explizit `J/K/A/D/Cmd+arrows` für SPÄTER freihalten — also nicht für Arrange. Vorschlag: Drag + Shift+←/→ für item-jump-focus.
- **`arrangement[]` ist das persistente State** — duplizierte Items haben dieselbe `chunkId`, eigene `id` (`arr-{chunkId}-{ts}-{i}`). User-Reorder schreibt zurück in `job.arrangement`.
- **TE-Spirit**: brass + cassette + LCD vocabulary. Nicht neu erfinden, aus Editor + Triage zusammenstellen.

### Pre-existing Caveats

- **WASM `pkg/` ist gitignored** — nach jedem Pull `bun run wasm:build` aus `frontend/`
- **Tests**: `bun x vitest run --project=unit` für unit, `bun x vitest run --project=browser` für browser-tests (Chromium via Playwright)
- **Worktree-Setup**: Dieser Branch lebt in `.claude/worktrees/quirky-dhawan-fb619b/`. PWD beim shell-cd beachten — manche Bash-Calls landen im Repo-Root statt frontend/
- **TypeScript-WASM-Errors** beim Typecheck (`Cannot find module sync_core.js`) sind pre-existing wenn pkg/ noch nicht gebaut wurde — `bun run wasm:build` fixt das
