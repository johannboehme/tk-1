/**
 * Undo/redo smoke (#69), end to end in a real Chromium.
 *
 * Seeds a direct-mode job from the README fixtures, opens the Editor,
 * records a cam-cut with the "2" hotkey, then exercises Cmd+Z /
 * Shift+Cmd+Z and asserts the change AND its persistence: auto-persist
 * must write the restored state back to IndexedDB (the whole point of
 * #69 — a wiped performance was un-recoverable within 300 ms).
 *
 * Prereq: dev server on :5173 (`npm run dev`).
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5173";
const log = (msg) =>
  console.log(`[undo-e2e] ${new Date().toISOString().slice(11, 19)} ${msg}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1456, height: 900 } });
ctx.on("pageerror", (err) => console.error("[page-error]", err.message));
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: "networkidle" });
log("upload page visible");

// Seed a two-cam direct job from the fixtures and wait for sync.
const jobId = await page.evaluate(async () => {
  const m = await import("/src/local/jobs.ts");
  async function asFile(url, name, type) {
    const r = await fetch(url);
    return new File([await r.blob()], name, { type });
  }
  const audio = await asFile(
    "/__readme_fixtures__/studio.mp3",
    "studio.mp3",
    "audio/mpeg",
  );
  const v1 = await asFile("/__readme_fixtures__/take-1.mp4", "take-1.mp4", "video/mp4");
  const v2 = await asFile("/__readme_fixtures__/take-2.mp4", "take-2.mp4", "video/mp4");
  const id = await m.createJob(
    [
      { file: v1, handle: null },
      { file: v2, handle: null },
    ],
    { file: audio, handle: null },
    { title: "Undo E2E", mode: "direct" },
  );
  for (let i = 0; i < 120; i++) {
    const j = await m.jobsDb.getJob(id);
    const vids = j?.videos ?? [];
    if (vids.length === 2 && vids.every((v) => v.sync && v.durationS)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return id;
});
log(`job synced: ${jobId}`);

await page.goto(`${BASE}/job/${jobId}/edit`, { waitUntil: "networkidle" });
await page.waitForSelector('[aria-label="Play"]', { timeout: 20_000 });
log("editor loaded");

// Dev-only StrictMode artifact: the double-mounted editor can race its
// own Web Lock and raise the "open in another tab" warning. Dismiss it
// so pointer interactions aren't intercepted (keyboard is unaffected).
const tabWarn = page.getByRole("button", { name: "Edit here anyway" });
if (await tabWarn.isVisible().catch(() => false)) {
  await tabWarn.click();
  log("dismissed second-tab warning (StrictMode lock race)");
}

async function idbCuts() {
  return await page.evaluate(async (id) => {
    const m = await import("/src/local/jobs.ts");
    const j = await m.jobsDb.getJob(id);
    return j?.cuts ?? [];
  }, jobId);
}

async function settlePersist() {
  // auto-persist debounce is 300 ms; give it comfortable slack.
  await page.waitForTimeout(900);
}

// Wait for the master audio's metadata so Space actually starts playback
// (HTMLMediaElement metadata load can be slow under headless Chromium).
await page.waitForFunction(
  () => {
    const aud = document.querySelectorAll("audio");
    return aud.length >= 1 && Number.isFinite(aud[0].duration);
  },
  { timeout: 20_000 },
);
log("audio metadata loaded");

// Advance the playhead into the song and record a cam-cut. A tap to the
// cam already on PROGRAM is a store no-op, and a cam without material at
// the playhead is too — so at increasing playhead positions try both
// hotkeys until one records.
await page.click("body");
let afterCut = [];
for (const target of [1.5, 5, 9, 14]) {
  await page.keyboard.press("Space");
  await page.waitForFunction(
    (t) => {
      const active = [...document.querySelectorAll("audio")].find(
        (a) => !a.paused,
      );
      return !!active && active.currentTime > t;
    },
    target,
    { timeout: 30_000 },
  );
  await page.keyboard.press("Space"); // pause at ~target
  for (const key of ["2", "1"]) {
    await page.keyboard.press(key);
    await settlePersist();
    afterCut = await idbCuts();
    if (afterCut.length > 0) break;
  }
  if (afterCut.length > 0) break;
}
if (afterCut.length !== 1) {
  const diag = await page.evaluate(() => ({
    audios: [...document.querySelectorAll("audio")].map((a) => ({
      paused: a.paused,
      t: a.currentTime,
      dur: a.duration,
    })),
    hooks: window.__editorTestHooks ?? null,
  }));
  throw new Error(
    `expected 1 persisted cut after cam hotkey, got ${afterCut.length} — ${JSON.stringify(diag)}`,
  );
}
log(`✓ cut recorded + persisted (${JSON.stringify(afterCut)})`);

// Transport affordance: undo button enabled, redo disabled.
const undoDisabled = await page
  .locator('[aria-label="Undo the last edit"]')
  .isDisabled();
const redoDisabled = await page
  .locator('[aria-label="Redo the last undone edit"]')
  .isDisabled();
if (undoDisabled || !redoDisabled) {
  throw new Error(
    `transport buttons wrong: undoDisabled=${undoDisabled} redoDisabled=${redoDisabled}`,
  );
}
log("✓ transport undo enabled / redo disabled");

// Cmd+Z — the cut disappears AND the empty cuts list persists to IDB.
await page.keyboard.press("Meta+z");
await settlePersist();
const afterUndo = await idbCuts();
if (afterUndo.length !== 0) {
  throw new Error(`expected 0 persisted cuts after undo, got ${afterUndo.length}`);
}
log("✓ Cmd+Z removed the cut and auto-persist wrote it through");

const toast = await page
  .locator('[data-testid="editor-notice"]')
  .textContent()
  .catch(() => null);
log(`undo toast: ${JSON.stringify(toast)}`);

// Shift+Cmd+Z — the cut returns and persists again.
await page.keyboard.press("Meta+Shift+z");
await settlePersist();
const afterRedo = await idbCuts();
if (afterRedo.length !== 1) {
  throw new Error(`expected 1 persisted cut after redo, got ${afterRedo.length}`);
}
log("✓ Shift+Cmd+Z restored the cut and persisted it");

// Redo button click path: undo once more via the transport button.
await page.click('[aria-label="Undo the last edit"]');
await settlePersist();
if ((await idbCuts()).length !== 0) {
  throw new Error("transport undo button did not undo");
}
log("✓ transport undo button works");

await browser.close();
log("PASS");
