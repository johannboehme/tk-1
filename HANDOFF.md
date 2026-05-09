# Handoff — video preview orientation bug

This branch was a long, partially-failed attempt to fix two adjacent
bugs in the editor's live video preview. **One is fixed and verified
end-to-end, one is unfixed and the investigation hit a wall.** This
document is honest about which is which so the next attempt doesn't
have to re-walk the same loops.

## What's actually shipped (already in main, not in this branch)

PR #41 (`fix(triage): flip cam-preview source-time sign`):

- The Triage and Arrange `CamPreview` components were computing
  `sourceT = masterT − syncOffsetMs/1000`, but every other consumer of
  `sync.offsetMs` (`local/timing/cam-time.ts`, `editor/types.ts:clipRangeS`,
  `local/jobs.ts:masterStartS = -(algoMs+userMs)/1000`) treats positive
  `syncOffsetMs` as "cam started BEFORE master t=0". The sign was
  flipped. Symptom: a video with ~193 s of pre-roll froze the preview
  for the entire pre-roll window then started from the cam's silent
  prelude (the "Maria José" report).
- Helper extracted to `local/timing/cam-preview-sync.ts` with regression
  tests including the 193 s case.

This PR works as advertised; not in scope for the rest of this doc.

## What this branch contains (uncommitted on `claude/triage-chunk-stutter`)

Two intertwined changes plus tests:

### A. Stutter mitigation in `VideoElementPool` — ✅ confirmed working

User reported the editor preview "ruckelt sehr stark" on every seek /
pill change, only smooth when pressing space from a steady-state
position. Root cause: the layer pass re-issued `<video>.currentTime =
sourceT` on every RAF tick when `|video.currentTime − sourceT| > 50 ms`,
which on multi-GB phone recordings tore the decoder open before it
could finish decoding the previous seek's keyframe. Positive-feedback
loop, never recovered.

Fix in `editor/render/video-element-pool.ts`:

- `prevTargetSourceT` is tracked per slot. Each `syncSlot` tick
  classifies the situation as JUMP (|delta| > 0.5 s forward, > 0.02 s
  backward, or first contact) vs NATURAL ADVANCE.
- JUMP threshold for triggering a seek: 50 ms drift (precise — user
  expects a clean snap on click).
- NATURAL threshold: 500 ms (lenient — let the element play freely;
  the browser keeps audio + muted-video close enough on its own clock).
- A self-rearming `requestVideoFrameCallback` chain on each slot bumps
  a `freshFrameToken` per presented frame and clears the per-slot
  `awaitingFreshFrame` flag the runtime uses to gate the fallback
  bitmap window.

User confirmed this fixed the stutter ("Du hast das Ruckeln jetzt
gelöst").

### B. Per-frame `createImageBitmap` snapshot path — ❌ does NOT fix the orientation regression it introduced

The original symptom was a 1-frame upside-down flicker on pill change
(Chrome's `copyExternalImageToTexture(<video>)` first-upload-after-seek
bug). The attempt to fix it grew into an architectural change:

- `preview-runtime.ts`: video sources are now ALWAYS routed through a
  cached `ImageBitmap` (refreshed on each `freshFrameToken` bump from
  the pool). The backend never samples the live `<video>` element
  directly anymore.
- `webgpu-backend.ts`: the `case "video"` branch only takes the
  fallback bitmap; if no bitmap is cached yet, the layer is skipped
  for that tick.
- `defaultCreateBitmapFromVideo` was rewritten to go through a
  Canvas2D `drawImage` intermediate (same path the on-screen
  `<video>` tag uses internally) on the theory that Chrome's direct
  `createImageBitmap(<video>)` might not apply the display rotation
  matrix on the user's specific file.

**This makes things worse, not better.** With this branch's code, the
user's video shows CONSISTENTLY upside-down in the editor — no longer
flickering once on pill change, but persistently inverted on every
frame. User has hard-refreshed, used incognito, restarted the dev
server with `--force`; the diagnostic `console.warn` confirms the
Canvas2D-roundtrip path runs and reports `videoEl.videoWidth/Height
= 1530 x 2752` (correct portrait). And yet the visible canvas output
is upside down.

### C. Test infrastructure — ✅ keep regardless

`editor/render/webgpu-backend-video-flip.browser.test.ts` covers four
orientation cases through real WebGPU + readbackForTest:

1. `kind: "image"` baseline — synthetic red-top/green-bottom bitmap
   renders right-side-up.
2. `kind: "video"` with `preferFallback: true` — same bitmap, video
   path. Renders right-side-up.
3. Rotated portrait fixture (`__test_fixtures__/user-rotated-sample.mp4`,
   30 KB, 320×178 codec landscape with `rotation=90` metadata —
   re-encoded slice mimicking the user's Ambarella file structure).
   WebGPU output is pixel-identical to the Canvas2D `drawImage`
   reference per quadrant.
4. Live `<video>` via `createImageBitmap`. WebGPU output matches the
   Canvas2D drawImage reference's top/bottom orientation.

**ALL FOUR PASS in headless Chromium (Playwright).** They also
checked the user's actual file (a stream-copied 3 MB slice of
`/Users/devien/Downloads/VID_20260509_104631_00_229.mp4`); that
fixture has been deleted from this branch (too big to commit, easy
to regenerate via `ffmpeg -ss 5 -i <file> -t 0.3 -c copy out.mp4`).
The slice test passed too.

So: **the tests prove the code path is orientation-correct in headless
Chromium, but the user's real Chrome on macOS shows it upside-down.**
That gap is the unsolved part.

## The bug that didn't die: hypotheses I couldn't disprove

The console.warn diagnostic confirms in the user's browser:
- `defaultCreateBitmapFromVideo` runs (Canvas2D-roundtrip path).
- `videoEl.videoWidth × videoEl.videoHeight = 1530 × 2752` (post-rotation
  portrait — Chrome HAS applied the rotation matrix to the element's
  display dims).

Yet the editor canvas displays the video upside-down. Possibilities I
couldn't narrow down without further interactive testing in the user's
actual browser:

1. **WebGPU swap-chain Y orientation differs by platform.** Chrome's
   Metal-backed WebGPU on macOS may present the canvas's swap-chain
   texture flipped relative to SwiftShader (which Playwright headless
   uses). Spec is unclear about origin convention for
   `context.getCurrentTexture()` — could be a Chrome bug. The fact
   that `<video>` tag and Canvas2D both render correctly while WebGPU
   doesn't is a strong signal here.
2. **A second render pass somewhere in the editor flips Y after the
   layer pass.** I scanned the FX loop and the present blit; both
   look like straight `copyTextureToTexture` calls. But I didn't
   verify on a live editor.
3. **Some CSS/DOM transform on the canvas or its parent.** I grepped
   for `scaleY`, `transform: rotate`, etc. Nothing visible. But
   `<canvas>` inside `OutputFrameBox` inside `EditorShell` is several
   layers deep.

The investigation hit a wall when I tried to reproduce the bug myself
via the chrome-MCP and ran into login/session/job-state issues — the
user's job lives in their browser's IndexedDB and OPFS; my controlled
Chrome doesn't have that data. Reproducing requires uploading the
actual 8.66 GB file in a fresh browser, which I didn't do.

## Recommended next moves for whoever picks this up

In order of likely payoff:

1. **First, decide: revert the architectural change in B?** The
   1-frame flicker that B was meant to fix is far less bad than
   "always upside-down". The pool's stutter mitigation (A) is
   self-contained in `video-element-pool.ts` and doesn't depend on B.
   Reverting `preview-runtime.ts` + `webgpu-backend.ts` + the
   bitmap-only test changes back to main would restore the previous
   "1-frame flicker on pill change" behavior, which the user lived
   with. That's a stable place to start.
2. **Reproduce the bug in your own controlled Chrome.** Upload the
   user's `VID_20260509_104631_00_229.mp4` into a fresh job at
   `http://localhost:5175/`. Once you can see the upside-down output
   yourself, you have a fast iteration loop instead of relying on the
   user.
3. **If the bug only happens with the bitmap-only path (B), and not
   with the original "live element to backend" path, that's the smoking
   gun.** Either the Canvas2D-roundtrip is producing a flipped bitmap
   on macOS Metal (despite Chromium-headless-Vulkan showing it correct
   in the test suite), or the `copyExternalImageToTexture(bitmap)` path
   in macOS Metal flips ImageBitmaps. The fix in either case is a
   single `flipY: true` in the upload OR a single `srcFlipY=true` in
   the layer shader for video sources — but verify which one in a
   real Mac browser before committing.
4. **The orientation tests in
   `webgpu-backend-video-flip.browser.test.ts` are reusable** — point
   them at any new fixture. They run end-to-end through the real
   WebGPU backend with pixel readback, so any new fix should keep
   them green and add a new case for the failing scenario.
5. **DON'T** trust my many "this is the fix" claims in the chat
   transcript. Multiple of them were wrong. The only things that have
   been independently verified are: A works, the four orientation
   tests pass in Playwright Chromium, the cleanup-removed debug
   page (`__debug_video_flip.html`) was a real reproducer attempt
   inside the chrome-MCP that died loading the 3 MB fixture.

## Files in this branch

Modified:
- `frontend/src/components/triage/CamPreview.tsx` — moved import to
  `local/timing/cam-preview-sync` (helper relocation).
- `frontend/src/components/arrange/CamPreviewArrange.tsx` — same.
- `frontend/src/editor/render/preview-runtime.ts` — bitmap-only video
  path + token-driven snapshot refresh + Canvas2D-roundtrip helper.
- `frontend/src/editor/render/preview-runtime.test.ts` — updated tests
  for the new architecture.
- `frontend/src/editor/render/video-element-pool.ts` — stutter
  mitigation (continuous rVFC chain, jump-vs-natural classification,
  `awaitingFreshFrame` + `freshFrameToken` API).
- `frontend/src/editor/render/video-element-pool.test.ts` — new tests
  for stutter logic.
- `frontend/src/editor/render/webgpu-backend.ts` — `case "video"` only
  takes the fallback bitmap.

Renamed:
- `cam-preview-sync.{ts,test.ts}` from `components/triage/` to
  `local/timing/` so triage and arrange both import from a neutral
  location.

Added:
- `frontend/src/editor/render/webgpu-backend-video-flip.browser.test.ts`
  — pixel-readback orientation tests (4 cases).
- `frontend/src/local/timing/cam-preview-sync.ts` + `.test.ts` —
  moved from triage/.
- `frontend/public/__test_fixtures__/user-rotated-sample.mp4` — 30 KB
  fixture, 320×178 codec landscape with `rotation=90` (mimics user's
  Ambarella body-cam encoding).

Tests: `bun run vitest --project unit` → 980/980 pass.
       `bun run vitest --project browser src/editor/render/webgpu-backend-video-flip.browser.test.ts` → 4/4 pass.
