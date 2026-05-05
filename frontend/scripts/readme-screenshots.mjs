// One-shot script that drives a real Chromium and captures the README screenshots.
// Uses the bundled test fixtures to create a real long-form session job, then
// walks every panel referenced from the README. Used only for repo asset
// generation; not part of the build.
//
// Usage:
//   npm run dev                                # in another terminal
//   node scripts/readme-screenshots.mjs        # writes to ../.github/screenshots/
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", ".github", "screenshots");
await mkdir(outDir, { recursive: true });

// README screenshots use a separate fixture set with real-looking
// performance footage and a short instrumental track, instead of the
// solid-colour synthetic clips the test suite uses. See ATTRIBUTION.md
// in the fixture dir for sources and licenses.
const fixtures = resolve(here, "..", "public", "__readme_fixtures__");
const sourceAudio = join(fixtures, "studio.mp3");
const sourceVideos = [
  join(fixtures, "take-1.mp4"),
  join(fixtures, "take-2.mp4"),
  join(fixtures, "take-3.mp4"),
];

// The 30 s source audio produces a single chunk in Triage (no internal
// silences), which makes the Triage rack and Arrange contact sheet look
// half-baked in the README. Stitch three 10 s slices together with 5 s
// of true silence between them — three musical chunks, two clean silence
// gaps, total ~40 s. Match the videos so the editor's timeline doesn't
// trail into 30 s of empty lane. Both are derived outputs (gitignored)
// regenerated only when missing.
const audioPath = join(fixtures, "long-studio.mp3");
const videoPaths = [
  join(fixtures, "long-take-1.mp4"),
  join(fixtures, "long-take-2.mp4"),
  join(fixtures, "long-take-3.mp4"),
];

if (!existsSync(audioPath)) {
  console.log("generating long-studio.mp3 (3 chunks, 2 silence gaps)…");
  execSync(
    [
      "ffmpeg -y -loglevel error",
      `-i "${sourceAudio}" -i "${sourceAudio}" -i "${sourceAudio}"`,
      `-filter_complex "[0:a]atrim=duration=10,apad=pad_dur=5[a0];[1:a]atrim=duration=10,apad=pad_dur=5[a1];[2:a]atrim=duration=10[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]"`,
      `-map "[out]" -b:a 128k "${audioPath}"`,
    ].join(" "),
    { stdio: "inherit" },
  );
}

for (let i = 0; i < sourceVideos.length; i++) {
  if (!existsSync(videoPaths[i])) {
    console.log(`generating ${videoPaths[i].split("/").pop()}…`);
    // Trim + pad with black/silence + concat. Audio lives alongside video so
    // sync has something to correlate against the master — `-an` here would
    // wedge sync forever (no source audio to align to).
    execSync(
      [
        "ffmpeg -y -loglevel error",
        `-i "${sourceVideos[i]}"`,
        `-f lavfi -i "color=c=black:s=1280x720:r=30:d=5"`,
        `-f lavfi -i "anullsrc=cl=stereo:r=44100:d=5"`,
        `-filter_complex "`,
        `[0:v]trim=duration=10,setpts=PTS-STARTPTS,format=yuv420p[v0];`,
        `[0:a]atrim=duration=10,asetpts=PTS-STARTPTS[a0];`,
        `[1:v]format=yuv420p[bk];`,
        `[2:a]asetpts=PTS-STARTPTS[sil];`,
        `[v0][a0][bk][sil][v0][a0][bk][sil][v0][a0]concat=n=5:v=1:a=1[outv][outa]`,
        `"`,
        `-map "[outv]" -map "[outa]"`,
        `-c:v libx264 -crf 28 -preset veryfast`,
        `-c:a aac -b:a 96k`,
        `"${videoPaths[i]}"`,
      ].join(" "),
      { stdio: "inherit" },
    );
  }
}

const base = process.env.VAS_BASE_URL ?? "http://localhost:5173";

const browser = await chromium.launch({
  args: ["--enable-features=SharedArrayBuffer"],
});
// Viewport tall enough that the upload page's DIRECT/SESSION routing
// cards land in-frame for the hero shot. PNGs stay ≤ 2000 px on the long
// side so chat tools that have an image-dimension cap can read them.
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
});

// The first-install PWA overlay sits on top of every page until the service
// worker reports offlineReady. In dev that never fires (PWA is gated off);
// in preview it can take ~minutes to download the precache. Either way it
// blocks our automation, and we don't want it in the README anyway.
await ctx.addInitScript(() => {
  const css = '[aria-label*="Installing TK-1"]{display:none !important}';
  const apply = () => {
    const s = document.createElement("style");
    s.textContent = css;
    (document.head ?? document.documentElement).appendChild(s);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

// Force the legacy `<input type=file>` picker path so Playwright's
// `filechooser` event can intercept the upload dialog. The native
// `showOpenFilePicker()` opens an OS file dialog that can't be controlled
// from automation. file-picker.ts already has a clean fallback when this
// global is absent.
await ctx.addInitScript(() => {
  delete window.showOpenFilePicker;
});

const page = await ctx.newPage();

async function shot(path, { wait = 600, fullPage = false } = {}) {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(outDir, path), type: "png", fullPage });
  console.log("✓", path);
}

async function gotoShot(path, url, opts) {
  await page.goto(`${base}${url}`, { waitUntil: "networkidle" });
  await shot(path, opts);
}

// ─── empty hero ────────────────────────────────────────────────────────────
// Upload page in its empty state, full page so the DIRECT / SESSION routing
// cards land in-frame underneath the dropzones.
await gotoShot("01-upload.png", "/", { fullPage: true });

// ─── upload + sync via the SESSION (longform) routing card ─────────────────
// SESSION builds a real long-form job so /triage and /arrange render with
// chunks/Polaroids instead of empty states. (DIRECT mode still works the
// same — handleSubmit just sets job.mode and sync runs either way.)
//
// The picker is now capability-aware: it dispatches a real `<input>` click
// (we forced that path above by deleting `showOpenFilePicker`), so we use
// Playwright's `filechooser` event to intercept and set the files.
console.log("uploading fixtures…");
const audioChooser = page.waitForEvent("filechooser");
await page.locator("#picker-audio").click();
await (await audioChooser).setFiles(audioPath);

const videoChooser = page.waitForEvent("filechooser");
await page.locator("#picker-videos").click();
await (await videoChooser).setFiles(videoPaths);
await page.waitForTimeout(300);

console.log("entering SESSION mode…");
await page.getByRole("button", { name: /Have an hour/i }).click();

// JobPage shows up first; sync runs there. The 5-stage pipeline can take
// a while on first run (vite dev cold-cache + WASM init + envelope/chroma/
// PHAT/consensus/drift); give it a generous window. We wait for the post-
// sync action buttons ("Quick render", "Continue → Triage", or "Open editor")
// since those only render once `hasSyncData` flips true.
console.log("waiting for sync…");
await page.waitForURL(/\/job\/[^/]+$/, { timeout: 30_000 });
// LongformStageButtons surfaces stage names (TRIAGE / ARRANGE / EDITOR)
// directly; DIRECT mode shows "Quick render" + "Open editor". Match either.
await page.waitForSelector(
  "text=/quick render|^triage$|^arrange$|^editor$|open editor/i",
  { timeout: 300_000 },
);
const jobUrl = page.url();
const jobId = jobUrl.match(/\/job\/([^/?#]+)/)[1];
console.log("synced →", jobId);

// History (now has the long-form job)
await gotoShot("02-jobs.png", "/jobs");

// Job detail (sync results — confidence + sharpness numbers + per-cam offsets)
await gotoShot("03-job-detail.png", `/job/${jobId}`);

// Helper: trigger playback for a moment so cam previews / video previews
// have a decoded frame painted. Empty black previews look like a half-loaded
// app; one play-then-pause cycle gives every panel real content.
async function paintPreview(holdMs = 1_500) {
  await page.locator("body").click({ position: { x: 50, y: 50 } });
  await page.keyboard.press("Space");
  await page.waitForTimeout(holdMs);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
}

// ─── Triage rack ───────────────────────────────────────────────────────────
// Chunk detection runs on Triage mount; wait for the ChunksList to populate,
// click into the first chunk so the inspector populates, then play briefly
// so the cam preview shows a frame instead of a black box.
console.log("opening triage…");
await page.goto(`${base}/job/${jobId}/triage`, { waitUntil: "networkidle" });
await page.waitForSelector("text=/CHUNKS/i", { timeout: 30_000 });
await page.waitForTimeout(2_500); // let detection settle + waveform render
await page.locator("text=/^#01/").first().click().catch(() => {});
await page.waitForTimeout(400);
await paintPreview(1_500);
await shot("triage-rack.png");

// ─── Arrange film strip ────────────────────────────────────────────────────
// First-mount of Arrange seeds arrangement = triage.kept, which gives the
// FilmStrip + ContactSheet content to render. Play briefly so the
// PlayerCockpit LCD shows a real audio readout instead of "AWAITING SIGNAL".
console.log("opening arrange…");
await page.goto(`${base}/job/${jobId}/arrange`, { waitUntil: "networkidle" });
await page.waitForSelector("text=/CHUNKS/i", { timeout: 15_000 });
await page.waitForTimeout(2_000); // let Polaroids develop
await paintPreview(1_500);
await shot("arrange-filmstrip.png");

// ─── Editor — SYNC tab (USER OVERRIDE knob, NUDGE MS row, MATCH lane) ─────
console.log("opening editor…");
await page.goto(`${base}/job/${jobId}/edit`, { waitUntil: "networkidle" });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^cam 1$/i }).first().click().catch(() => {});
await paintPreview(1_500);
await shot("editor-sync.png", { wait: 400 });
// Keep legacy filename for backwards-compat with any external links.
await shot("04-editor-sync.png", { wait: 0 });

// Options tab — per-clip viewport / rotate / flip
await page.getByRole("tab", { name: /options/i }).click().catch(() => {});
await shot("05-editor-options.png", { wait: 500 });

// Overlays tab
await page.getByRole("tab", { name: /overlays/i }).click().catch(() => {});
await shot("06-editor-overlays.png", { wait: 500 });

// Export tab — Stage presets (WEB / MOBILE / ARCHIVE / CUSTOM) + quality slider
await page.getByRole("tab", { name: /export/i }).click().catch(() => {});
await shot("07-editor-export.png", { wait: 500 });

// ─── FX hardware panel + ADSR envelope ────────────────────────────────────
// Re-show the SYNC tab so the right rail doesn't dominate the frame, then
// expand the FX panel and flip the LCD into envelope mode so the phosphor
// trapezoid + four knots are visible.
console.log("opening FX panel…");
await page.getByRole("tab", { name: /sync/i }).click().catch(() => {});
await page.waitForTimeout(300);
await page.getByRole("button", { name: /show fx panel/i }).click().catch(() => {});
await page.waitForTimeout(600);
await page.getByRole("button", { name: /show envelope/i }).click().catch(() => {});
await shot("fx-hardware-panel.png", { wait: 800 });

// Help overlay (Shift+/ → "?")
await page.locator("body").click({ position: { x: 400, y: 400 } });
await page.keyboard.press("Shift+/");
await shot("08-editor-help.png", { wait: 500 });
await page.keyboard.press("Escape");

// Settings
await gotoShot("09-settings.png", "/settings");

await browser.close();
console.log("Done →", outDir);
