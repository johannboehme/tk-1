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
const audioPath = join(fixtures, "studio.mp3");
const videoPaths = [
  join(fixtures, "take-1.mp4"),
  join(fixtures, "take-2.mp4"),
  join(fixtures, "take-3.mp4"),
];

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
  { timeout: 120_000 },
);
const jobUrl = page.url();
const jobId = jobUrl.match(/\/job\/([^/?#]+)/)[1];
console.log("synced →", jobId);

// History (now has the long-form job)
await gotoShot("02-jobs.png", "/jobs");

// Job detail (sync results — confidence + sharpness numbers + per-cam offsets)
await gotoShot("03-job-detail.png", `/job/${jobId}`);

// ─── Triage rack ───────────────────────────────────────────────────────────
// Chunk detection runs on Triage mount; wait for the ChunksList to populate
// before screenshotting the rack.
console.log("opening triage…");
await page.goto(`${base}/job/${jobId}/triage`, { waitUntil: "networkidle" });
await page.waitForSelector("text=/CHUNKS/i", { timeout: 30_000 });
await page.waitForTimeout(2_000); // let detection settle + waveform render
await shot("triage-rack.png");

// ─── Arrange film strip ────────────────────────────────────────────────────
// First-mount of Arrange seeds arrangement = triage.kept, which gives the
// FilmStrip + ContactSheet content to render.
console.log("opening arrange…");
await page.goto(`${base}/job/${jobId}/arrange`, { waitUntil: "networkidle" });
await page.waitForSelector("text=/CHUNKS/i", { timeout: 15_000 });
await page.waitForTimeout(2_000); // let Polaroids develop
await shot("arrange-filmstrip.png");

// ─── Editor — SYNC tab (USER OVERRIDE knob, NUDGE MS row, MATCH lane) ─────
console.log("opening editor…");
await page.goto(`${base}/job/${jobId}/edit`, { waitUntil: "networkidle" });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^cam 1$/i }).first().click().catch(() => {});
await shot("editor-sync.png", { wait: 600 });
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
