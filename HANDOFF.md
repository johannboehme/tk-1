# Reel feature — handoff

A new **Reel** mode: combine several finished projects into one rendered
video (TK-1 as an iMovie replacement for "Part A then Part B"). Branch:
`reels`. ~15 commits on top of `main`.

## What it is (locked product decisions)

- A reel = an ordered set of **projects** rendered back-to-back into one MP4.
- Members are rendered **fresh from each project's edit** (NOT from a pre-
  rendered output) through the existing WebCodecs pipeline, onto a **common
  output stage** (per-member letterbox + pan/zoom framing).
- Hard cuts between members. Whole projects (no cross-project clip editing).
- **Persisted** in IndexedDB (own `reels` store). Top-level surface at
  `/reel/:id`, opened from the Library (ex-"History").
- Naming (visible text only): **Library / Project / Reel**. Code identifiers
  (`LocalJob`, `/job/:id`, `jobsDb`) unchanged.

## Architecture / where things live

**Backend (render)**
- `src/local/reel/build-render-input.ts` — `buildRenderInputFromJob(job)`:
  rebuilds a job's full `EditSpecLocal` (segments/overlays/cuts/pills/
  exportOpts/per-cam overrides) from its persisted row, mirroring the editor's
  `buildEditSpec` + `Editor.tsx#onSubmit`. **Pure, unit-tested.**
- `src/local/reel/clamp-segments.ts` — clamps member segments to cam content
  extent (drops test-pattern tails). Pure, unit-tested.
- `src/local/render/render-sink.ts` — `RenderSink` seam. `SingleRenderSink`
  (legacy single-job, byte-identical) + `SharedReelSink` (one muxer across N
  members, cumulative video offset, dedup'd decoder config).
- `src/local/render/edit.ts` — `editRenderMulti` refactored to accept
  `sink` / `skipAudio` / `outer` (contain-fit onto a larger reel stage).
- `src/local/render/reel.worker.ts` — reel render worker: encodes ONE gapless
  audio track, then each member video-only into the shared sink.
- `src/local/jobs.ts` — `runReelRender(input)` orchestrator (main thread:
  decode+resample audio per member to 48k stereo, trim by segments, frame-pad,
  concat; spawn worker), `cancelReelRender`, `reelOutputPath`,
  `buildCamWorkerInputs` (shared with `runEditRender`).
- `src/storage/jobs-db.ts` — `reels` object store (DB v9) + `ReelRecord` /
  `ReelMemberRecord` + CRUD (`listReels/getReel/saveReel/updateReel/deleteReel`).
  Also persists `overlays`/`visualizer`/`offsetOverrideMs` on `LocalJob`
  (were editor-store-only; needed for faithful headless render).

**UI**
- `src/pages/Reel.tsx` — 3-column surface: left = sortable project list
  (order), middle = `ReelPlayer`, right = `ExportControls` (render panel).
  Full-width bottom `ReelTimeline`. Space toggles play.
- `src/components/reel/ReelPlayer.tsx` — whole-reel `<video>` player: one
  playhead across members, per-member framing (drag pan / wheel zoom /
  dblclick reset, orange L-marks). Positions video in **percent of stage**.
- `src/components/reel/ReelTimeline.tsx` — transport + proportional member
  strip + playhead scrub (whole reel).
- `src/editor/components/ExportPanel.tsx` — extracted store-free
  `ExportControls` (reused by editor + reel).
- `src/pages/History.tsx` — Library: Projects + Reels sections, select-mode
  "New reel".
- `src/local/reel/reel-store.ts` — ephemeral-but-persisted reel store
  (`createReel`, `deleteReel`, load/debounced-save, render lifecycle).

## Verified working (real Chromium, via test fixtures)

- Render engine concatenates N members into one MP4, both fully decodable,
  gapless ordered audio (`src/local/render/reel.browser.test.ts`).
- Player shows real frames + plays across the whole reel; member select
  switches the picture; Space toggles; scrub-in-clip holds.
- Default output inherits the first project's persisted exportSpec (9:16/codec).
- 1076 unit tests + production build green.

## OPEN BUG (top priority) — longform reel renders too long

**Symptom:** user added 2 **longform** projects (heavily triaged), reel
rendered ~31 min (the full originals).

**Status: root cause NOT confirmed.** My first fix (commit `a9d114c`) added a
fallback to ACCEPTED chunks when a longform job has an *empty* arrangement —
but the user clarified they **had an arrangement** (just the last clip) and
went through to the editor for both projects. So the empty-arrangement fallback
is likely NOT their cause. The real cause is still unknown.

**Verified facts (so the next session doesn't re-tread):**
- `buildRenderInputFromJob` with a real arrangement returns ONLY the arranged
  chunk segments (proved: arrangement of 2 chunks → 6s, not the 30s recording).
  So the factory itself looks correct for arrangement-present.
- Therefore the bug is either (a) in the user's actual job data (the kept "last
  clip" chunk may genuinely be long — verify chunk durations!), or (b)
  downstream of the factory (`runReelRender` → `clampSegmentsToContent` →
  worker → `editRenderMulti`), or (c) `arrangementToSegments` mis-mapping the
  real chunk ranges.

**Fastest diagnosis (do this first):** in the running app, dump the real job's
segments for one longform member:
```js
const { buildRenderInputFromJob } = await import('/src/local/reel/build-render-input.ts');
const { jobsDb } = await import('/src/storage/jobs-db.ts');
const job = await jobsDb.getJob('<longformJobId>');   // get id from jobsDb.listJobs()
const spec = buildRenderInputFromJob(job);
console.log('segments', spec.segments,
  'totalSec', spec.segments.reduce((a,s)=>a+(s.out-s.in),0),
  'arrangement', job.arrangement, 'chunks', job.chunks?.map(c=>[c.id,c.startMs,c.endMs,c.accepted]));
```
- If `totalSec` is SHORT but the reel still renders long → bug is downstream
  (instrument `runReelRender`: log each member's clamped `segments` +
  `videoFrameCount`; check `clampSegmentsToContent` isn't widening; check the
  worker's `editRenderMulti` intervals).
- If `totalSec` is LONG → either the kept chunk is genuinely long (not a bug),
  or `arrangementToSegments` (`src/local/arrange/chunks-to-segments.ts`) is
  returning the wrong ranges for the real arrangement shape.

## Other known limitations / follow-ups

- **Preview audio** = each member video's own (phone) track, synced to picture.
  The RENDER uses each project's studio master. Preview sound is a rough guide;
  a faithful preview would play the master audio synced (heavier).
- **Reel member trim** at the reel level is not exposed in the UI (members
  render their full edit). `ReelMemberRecord.trimInS/trimOutS` exist in the
  schema for it.
- Scrubbing during playback may pause the video (acceptable; "snap-back" bug is
  fixed). Confirm desired play-through-scrub behaviour with the user.
- A/V at member boundaries: audio is PCM-concatenated + frame-padded to each
  member's video frame count; fine for short reels, watch drift on very long.
- ffmpeg.wasm is NOT used for the reel (WebCodecs single-muxer path); it remains
  only the in-pipeline codec fallback.

## How to run / test

- `cd frontend && npm install --legacy-peer-deps && npm run wasm:build`
- `npm run dev` (COOP/COEP headers; needs Chromium for WebGPU/WebCodecs)
- Tests: `npm run test` (unit), `npm run test:browser` (Chromium),
  `npm run lint` (tsc)
- Test fixtures are served in dev at `/__test_fixtures__/*.mp4` — you can
  synthesize a reel from the console (see the diagnosis snippet) without
  uploading real media.
- **Preview-MCP gotcha:** the `desktop` preset screenshot can render a 1px
  sliver (capture artifact, not a layout bug). Use explicit `width/height`
  (e.g. 1280×800). Restart the dev server after rapid edits — stale HMR can
  show a phantom-broken page.
