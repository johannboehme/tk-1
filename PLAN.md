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

- **Triage**: erkennt Stille-Pausen, schlägt musikalische Chunks vor (BPM/Bar-aligned), User akzeptiert/verwirft/trimmt. Multi-Cam-Preview, Sync-Nudging möglich.
- **Arrange**: User sortiert die akzeptierten Chunks per Mini-Arranger, kann duplizieren.
- **Editor**: bekommt eine vorbefüllte EditSpec mit Multi-Pill-Lanes (mehrere Sub-Ranges pro Cam), Master-Audio bleibt unangetastet, Segments[] wird zur Playlist.

**Constraints (non-negotiable)**:
- Memory-konstant bei 1h+ / multi-GB Footage (File-Handles + Streaming-Decoder existieren bereits)
- Audio-Wiedergabe rock-solid für die latenz-empfindliche Zielgruppe (kein Knack/Klick bei Chunk-Übergängen)
- Bar-Snap muss sich DAW-mäßig anfühlen (magnetisch, mit Modifier-Override)

---

## Schlüssel-Entscheidungen

1. **Master-Audio bleibt Original** — kein Re-Encode. Segments[] (existiert in EditSpec) wird zur logischen Playlist; Playback springt zwischen Original-Zeitbereichen via Crossfade-Pattern aus `useAudioMaster` (existiert).
2. **Sync ist Job-Property** — auto-sync läuft wie bisher als allererster Step. Manuelles Nudging möglich in jeder Phase. Werte propagieren zwischen Phasen über Job-Store.
3. **Chunks und Arrangement leben am Job, nicht in EditSpec** — überleben Editor-Edits. Editor-Edits sind chunk-lokal (keyed über pill-id der vom chunk-id abgeleitet wird) und überleben das Hinzufügen neuer Chunks in Triage.
4. **Triage = stripped-down Editor-Scaffold**, kein Mode-Toggle im Editor selbst. Wiederverwendung über shared Komponenten (Waveform-Renderer, Bar-Ruler, Loop-Master), nicht über Feature-Flags am Editor.
5. **Multi-Pill-Lane-Refactor wird so spät wie möglich gemacht** — erst kurz vor „Send to Editor" (Phase 6), damit Triage + Arrange ohne Editor-Stabilitätsrisiko entstehen können.
6. **Cam-Wahl pro Frame bleibt Editor-Job** — Triage zeigt Cams nur als Preview-Switcher, bäckt keine Cut-Entscheidungen vor.
7. **Cherry-Picking in Triage, Sortieren in Arrange** — keine doppelten Reject-Knöpfe.
8. **Frontend-Design Skill ist Pflicht** für jede UI-Phase. TE-Spirit (skeuomorph, Real-World-Music-Gear) wie im existierenden Editor.

---

## Datenmodell-Erweiterungen

```ts
// Job-Level (neu)
type JobMode = "direct" | "longform";

interface SilenceConfig { thresholdDb: number; minPauseMs: number; }

interface Chunk {
  id: string;                     // stable ID, survives re-detection
  startMs: number;                // master-audio time
  endMs: number;
  detectedBpm?: number;           // per-chunk
  bpmOctaveShift: 0 | -1 | 1;     // user override (×2 / ÷2)
  effectiveBpm: number;           // detectedBpm * 2^bpmOctaveShift OR sessionBpm
  bars?: number;                  // computed from effectiveBpm + duration
  beatsPerBar: number;            // default 4
  accepted: boolean;              // include in arrangement
  trimMode: "auto" | "bar" | "free";
  // optional override of detected boundaries
  trimStartMs?: number;
  trimEndMs?: number;
}

interface ArrangementItem {
  id: string;                     // unique per arrangement entry (chunk can appear multiple times)
  chunkId: string;
  // future: per-instance crossfade overrides etc.
}

// LocalJob extension
interface LocalJob {
  // ... existing fields
  mode: JobMode;
  silenceConfig?: SilenceConfig;  // last user values
  sessionBpmOverride?: number;    // session-wide force BPM
  chunks?: Chunk[];               // long-form only
  arrangement?: ArrangementItem[]; // long-form only
  triageEnvelope?: Float32Array;  // cached so Triage opens instant
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
  startOffsetS: number;          // in master timeline
  // chunk back-reference (long-form jobs only)
  fromChunkId?: string;
  fromArrangementId?: string;
}
```

---

## Phasen-Übersicht

| Phase | Status | Beschreibung |
|-------|--------|--------------|
| 1. Routing + Entry | ✅ done | Mode-Wahl beim Upload, Triage/Arrange-Routes, JobPage routing |
| 2. Detection Backend | ✅ done | WASM silence_segments, per-chunk BPM, jetzt im Sync-Step |
| 3. Triage UI | ⚠️ in progress | Voll funktional, User testet — siehe Status-Section unten |
| 4. Triage Polish | ✅ kollabiert in Phase 3 | Click-through, BPM-octave, bar-snap, gapless audio — alles in Phase 3 reingefaltet |
| 5. Arrange Phase | 🚧 not started | UI-Konzept skizziert, hat sogar einen halben Anlauf bekommen aber wieder verworfen weil Triage zuerst fertig sein muss |
| 6. Multi-Pill Editor Refactor | 🚧 not started | Großer Brocken, Editor-State-Modell ändert sich |
| 7. Send to Editor + Segment Playback | 🚧 not started | Verbindet Arrange ↔ Editor; braucht Phase 6 |
| 8. Polish | 🚧 not started | Sensitivität, Performance, Documentation |

---

## Phasen-Details

### Phase 1 — Routing, Entry-Point, Job-State-Machine ✅

**Ziel**: User kann durch den neuen Flow navigieren.

**Umgesetzt**:
- Upload-Page mit zwei ChunkyButton-Cards (`03A · DIRECT` / `03B · SESSION`) als Step-3-Routing — Bevel statt dashed-border, kein Opacity-Trick
- LocalJob-Felder: `mode`, `silenceConfig`, `sessionBpmOverride`, `chunks`, `arrangement`, `triageEnvelope` (alle optional)
- Routes `/job/:id/triage`, `/job/:id/arrange` hinter `JobPermissionRoute`
- `nextRouteForJob()` als Single-Source-of-Truth fürs Routing — `arrangement === undefined` ist die „Triage done"-Marke (NICHT nur chunks-existieren)
- PhaseStrip-Component (48px high, full-bleed) shared zwischen Triage + Arrange

**Files**: `src/pages/Upload.tsx`, `src/App.tsx`, `src/local/jobs-routing.ts(.test.ts)`, `src/pages/Triage.tsx`, `src/pages/Arrange.tsx`, `src/storage/jobs-db.ts`

---

### Phase 2 — Detection Backend ✅

**Ziel**: Silence-Detection + Per-Chunk-BPM, callable von TS.

**Umgesetzt**:
- WASM `silence.rs` Modul mit `silence_segments(envelope, threshold_lin, min_pause_ms)` + 9 Rust-Tests
- WASM-Bridges `computeRmsEnvelope` und `silenceSegments` in `lib.rs`
- TS `chunk-detect.ts`: `detectChunks(pcm, sr, config)` und `detectChunksFromEnvelope` — letzteres für live Slider-Updates ohne PCM-Re-Decode
- Per-Chunk-BPM via `analyzeAudio()` auf Slices, mit `await setTimeout(0)` yields jeden zweiten Chunk damit Main-Thread nicht freezt
- 9 Browser-Tests (`chunk-detect.browser.test.ts`)
- **Detection läuft jetzt im Sync-Step** (für Long-Form-Jobs, am Ende von `runSync` bei pct 97), persistiert chunks + envelope

**Files**: `wasm/sync-core/src/silence.rs`, `wasm/sync-core/src/lib.rs`, `src/local/triage/chunk-detect.ts(.browser.test.ts)`, `src/local/triage/triage-orchestrator.ts`, `src/local/jobs.ts`

---

### Phase 3 — Triage UI ⚠️ in progress

**Ziel**: User-vollständiger Triage-Editor.

**Umgesetzt**:
- **Triage-Store** (`triage-store.ts`) — Zustand für playback, view (zoom/scrollX), chunks, focusedChunkId, selectedCamId, silenceConfig, sessionBpmOverride, pcm, envelope, cams
- **TriageTimeline**: Canvas-Waveform, Chunk-Lane (solid colors — hot=accepted, ink-2 mit strikethrough=rejected, cobalt-outline=focused), per-chunk bar-ruler basierend auf chunk effectiveBpm, time-ruler MM:SS
  - Mouse-wheel zoom anchored am Cursor, Shift+drag pan, click on chunk-lane focus, click waveform seek
  - Drag handles auf chunk left/right edges → snap-to-bar (Alt = freier Drag)
  - Pinch-zoom + 1-finger pan auf Touch (PointerEvent multi-pointer)
- **TriageTransportBar** (eigene Komponente, nicht TransportBar-recycelt — letzteres ist editor-store-coupled): Play/Pause + Prev/Next chunk + Keep/Drop. Shortcuts via `useRegisterShortcut`: `Space`, `Shift+←`/`Shift+→`, `Enter`, `Backspace` — alle DE-keyboard-safe
- **DetectionPanel**: Threshold + Min-Pause Slider mit live re-detection (50ms debounce, 250ms IDB persist) + Session-BPM-Override-Field
- **ChunkInspector**: Time/Length/Bars/BPM mit `÷2`/`×1`/`×2` octave shift, **Bar-Trim-Buttons** (extend/shrink je Ende), Keep/Drop
- **ChunksList**: Vertikale scrollbare Liste, click-to-focus, inline Keep/Drop, full-width tap targets für Mobile
- **CamPreview**: Hidden video element, seekt zu master-time minus syncOffset, switcht via SyncPatchPanel
- **SyncPatchPanel** wurde aus JobPage extrahiert nach `src/components/sync/SyncPatchPanel.tsx` — bekommt `onSelectCam` + `onNudgeCam` + `syncOverrides` Props. ◀▶ Nudge-Buttons (1ms, Alt-click=100ms)
- **TriageAudioMaster** (`useTriageAudio.tsx`): Dual-element ping-pong mit WebAudio gain-crossfade (8ms ramp, 50ms lead) — gapless loop wie editor's `useAudioMaster`, aber triage-store-driven
- **useTriagePersist**: 250ms debounced IDB write für chunks/silenceConfig/sessionBpm/cam-sync-overrides
- **Layout**: Desktop ≥ lg = 3-Spalten-Grid (Cam-Preview+Sync | Timeline+ChunksList | Detection+Inspector); < lg = vertical stack
- **Triage Continue → Arrange**: Seedet `arrangement` mit accepted chunks (chronologisch). Re-Entries fügen nur neue Chunks hinzu, behalten User-Sortierung

**Verbleibende Issues / Open Items in Triage** (siehe Status-Section unten für Details)

**Files**: 
- `src/local/triage/triage-store.ts`
- `src/local/triage/useTriagePersist.ts`
- `src/components/triage/TriageTimeline.tsx`
- `src/components/triage/TriageTransportBar.tsx`
- `src/components/triage/DetectionPanel.tsx`
- `src/components/triage/ChunkInspector.tsx`
- `src/components/triage/ChunksList.tsx`
- `src/components/triage/CamPreview.tsx`
- `src/components/triage/useTriageAudio.tsx`
- `src/components/sync/SyncPatchPanel.tsx`
- `src/pages/Triage.tsx`

---

### Phase 5 — Arrange Phase 🚧 not started

**Ziel**: User sortiert akzeptierte Chunks via Mini-Arranger.

**Geplante Komponenten** (Konzept-Skizze):
- ArrangementTimeline (horizontale flow von chunk-cards, click-to-focus, ←/→/×2/✕ controls)
- SourcePool (vertikale liste der accepted chunks mit add-button + usage count)
- ArrangeTransport (play/pause + Shift+arrows item-jump)
- Reuse von SyncPatchPanel + CamPreview wenn sinnvoll

**Files** (geplant):
- `src/local/arrange/arrange-store.ts`, `useArrangePersist.ts`
- `src/components/arrange/ArrangementTimeline.tsx`, `SourcePool.tsx`, `ArrangeTransport.tsx`
- `src/pages/Arrange.tsx`

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

## Critical Files Reference (für Phase-Execution)

**Read first** für jede Phase:
- `frontend/src/editor/types.ts` — Editor-Datenmodell
- `frontend/src/editor/store.ts` — Editor-Zustand
- `frontend/src/storage/jobs-db.ts` — Persistenz-Schema
- `frontend/src/editor/useAudioMaster.ts` — Audio-Crossfade-Pattern (gapless loop, dual-element)
- `frontend/src/editor/render/preview-runtime.ts` — Compositor-Loop
- `frontend/src/editor/render/video-element-pool.ts` — Decoder-Pool
- `frontend/src/local/render/audio-analysis/analyze.ts` — BPM/Onset/AudioStart
- `frontend/wasm/sync-core/src/envelope.rs` — RMS-Envelope
- `frontend/wasm/sync-core/src/silence.rs` — Silence detection (NEW)
- `frontend/src/editor/components/Timeline.tsx` — Lane-Render
- `frontend/src/editor/components/BpmReadout.tsx` — BPM-UI
- `frontend/src/local/triage/triage-store.ts` — Triage-Zustand
- `frontend/src/components/sync/SyncPatchPanel.tsx` — Per-cam sync display + nudging
- `frontend/src/components/sync/parse-stage.ts` — Sync-progress stage parser

---

## Verification Strategy (übergreifend)

- **Unit-Tests** pro Phase, TDD red→green→refactor (User-Memory).
- **Integration-Tests** in jeder Phase: Worker-Pipelines mit synthetischem PCM.
- **E2E-Tests** mit Playwright: Upload → Triage → Arrange → Editor → Render-Spec.
- **Manueller Audio-Test** für gapless playback paths.
- **Real-Footage-Test** ab Phase 3: User stellt 1h+ Session-Aufnahme zur Verfügung.
- **Memory-Profil** pro Phase mit Chrome DevTools, Constraint: < 300 MB Heap auch bei 4h-Sessions.

---

## Risiken / Open Items

1. **Multi-Pill-Refactor (Phase 6) ist die invasivste Änderung** — könnte schmerzen. Mitigation: extensive existierende Tests vorab grün, dann inkrementelle Migration.
2. **Per-Chunk-BPM kann auf kurzen Chunks unzuverlässig sein** (< 4 Bars). Mitigation: Fallback auf Session-BPM, UI-Indikator bei niedriger Confidence.
3. **Drag-Reorder in Arranger könnte Crossfade-Punkte hörbar machen wenn BPMs nicht matchen** — UI-Warnung + optional click-track Marker.
4. **Sync-Nudging an mehreren Stellen** könnte verwirren — klare visuelle Indikation „dies ist *die* eine Sync-Quelle" in jeder UI.

---

## Status & Notes for Next Session

Letzter Stand: **Phase 3 (Triage) ist funktional aber noch nicht vom User abgenommen.** Phase 5 (Arrange) ist auf Eis, weil Triage erst fertig sein muss.

### Was committed ist (auf diesem Branch)

11 Commits ahead of `main`:

```
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

### Bekannte offene Issues / User-Feedback noch nicht adressiert

1. **User soll Triage E2E mit echtem Long-Form-Material durchgehen** und Bugs/UX-Friktion melden. Nicht versuchen vorab alles selbst zu erraten — der User testet konkret und gibt punktgenaues Feedback.
2. **Arrange-Page** ist nur Placeholder mit „Arrange · coming next" Text. UI-Bau wartet auf Triage-Sign-off.
3. **Sequential Multi-Chunk-Playback** in Triage existiert nicht — User hört Chunks im Loop einzeln, nicht hintereinander. Phase 7 wird das richtig lösen via Segment-Handoff.

### Wichtige Lessons aus dieser Session (User-Feedback an mich selbst)

- **Nicht überscopen wenn der User „X weg" sagt** — nur das Surface entfernen, nicht das ganze Feature mit-killen. Beispiel: User sagte „Quick-Render-Button macht hier keinen Sinn" → ich hab das ganze quickRender-Feature inkl. Tests gelöscht. War falsch — gelten lassen für Direct-Mode-Jobs.
- **Detection-Pipeline gehört in den Sync-Step, nicht in eine zweite „decoding"-Phase im Triage**. Zwei Loading-Panels hintereinander = schlechte UX. Sync-Pipeline produziert die Vorarbeit, Triage öffnet instant.
- **Chunks alone ≠ Triage done**. Auto-detection produziert Chunks, aber das heißt nicht dass der User akzeptiert/abgelehnt hat. `arrangement === undefined` ist die echte „Triage done"-Marke. Das ist ein subtiles Routing-Detail das ich beim nächsten Mal direkt richtig machen sollte.
- **Sync-Stage-Parser muss neue Stage-Strings kennen**. `parseStage()` in `src/components/sync/parse-stage.ts` hat einen Fallback der unbekannte Strings auf `master: "pending"` mappt — wenn man einen neuen Stage-String hinzufügt, MUSS man parseStage erweitern, sonst flackert die Master-Pille auf „pending" zurück. Das hab ich beim ersten Versuch verpennt.
- **Editor-Komponenten sind store-gekoppelt** (`useEditorStore`). Direkt-recyceln in einem anderen Screen geht nicht. Optionen: (a) shared store überall, (b) Refactor auf Props, (c) Triage-spezifische Variante mit ähnlichem Pattern. Ich hab (c) gewählt für TransportBar + AudioMaster, (b) macht für später Sinn wenn der Mehrwert wächst.
- **Keine UI-Strings auf Deutsch im App-UI**. Memory `feedback_ui_strings_english.md` festgehalten. Auch in Placeholders / Loading-States / Error-Messages.
- **Solid colors für Status (accept/reject), keine Opacity-Tricks**. Memory `feedback_no_opacity_for_status.md`.
- **Keyboard-Shortcuts auf DE-Layout testen** — `[` `]` brauchen AltGr und sind unzuverlässig. Memory `feedback_keyboard_layout.md`. Wir nutzen `Shift+arrows`, `Enter`, `Backspace` — alle safe.
- **Editor maximal recyceln** (Memory `feedback_reuse_editor_ui.md`) — vor jeder UI-Konzept-Iteration den Reuse-Audit machen, Editor-Komponenten anschauen, dann erst designen.
- **„Später" sagen ist gefährlich**. Wenn man ein Feature für „Phase X" verschiebt, baut man in Wahrheit oft das UI doppelt. Lieber gleich vollständig planen + bauen.

### Wenn User die nächste Session öffnet

1. **Frag direkt was noch zu fixen ist** im Triage. Nicht raten oder annehmen.
2. **Dev-Server starten** (Memory `feedback_dev_server_at_session_end.md`) und konkrete Test-Anleitung geben.
3. **Vor jedem UI-Design**: Reuse-Audit (welche Editor-Komponenten gibt es schon?), dann Konzept abnehmen, dann erst bauen (Memory `feedback_design_iteration.md`).
4. **Kleine UI-Tweaks**: nicht jedes Mal in den Browser springen für Screenshots (Memory `feedback_skip_visual_check_for_small_changes.md`).

### Wenn Triage abgenommen ist, dann Phase 5 (Arrange)

Vor Beginn:
- Reuse-Audit: SyncPatchPanel und CamPreview wiederverwenden (selectedCamId-Logik kennen sie schon)
- Keyboard-Shortcuts für Arrange müssen DE-safe + nicht mit Triage-Shortcuts kollidieren — User wollte explizit `J/K/A/D/Cmd+arrows` für später freihalten
- Layout-Konzept (Desktop + Mobile) vom User abnehmen lassen bevor implementiert wird
- Audio-Playback in Arrange ist erstmal Loop-Preview eines fokussierten Items (gleiches Pattern wie Triage). Sequentielle Wiedergabe ist Phase 7

### Pre-existing Caveats die wichtig zu wissen sind

- **WASM `pkg/` ist gitignored** — nach jedem Pull `bun run wasm:build` aus `frontend/`
- **Tests**: `bun x vitest run --project=unit` für unit, `bun x vitest run --project=browser` für browser-tests (echte Chromium via Playwright)
- **Worktree-Setup**: Dieser Branch lebt in `.claude/worktrees/determined-antonelli-67ac91/`. PWD beim shell-cd beachten — manche Bash-Calls landen im Repo-Root statt frontend/
- **TypeScript-WASM-Errors** beim Typecheck (`Cannot find module sync_core.js`) sind pre-existing wenn pkg/ noch nicht gebaut wurde — `bun run wasm:build` fixt das
