/**
 * E2E visual + functional smoke test for the Arrange page.
 *
 * Launches a fresh Chromium per run, seeds a long-form job using the
 * readme fixtures, walks Arrange + Editor, screenshots key moments,
 * and asserts that arrangement → segments propagate into the editor.
 */
import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:5173";
const OUT = path.resolve("./e2e-screens");
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const log = (msg) =>
  console.log(`[e2e] ${new Date().toISOString().slice(11, 19)} ${msg}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1456, height: 900 } });
ctx.on("weberror", (e) => console.error("[browser-error]", e.error().message));
ctx.on("pageerror", (err) => console.error("[page-error]", err.message));
ctx.on("console", (msg) => {
  const t = msg.text();
  const skip =
    t.includes("React Router Future Flag") ||
    t.includes("React DevTools") ||
    t.includes("[vite]");
  if (skip) return;
  if (
    msg.type() === "error" ||
    msg.type() === "warning" ||
    t.includes("[editor-load]") ||
    t.includes("[arrange]")
  ) {
    console.log(`[browser-${msg.type()}]`, t.slice(0, 240));
  }
});
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector('text="Drop the song."', { timeout: 10_000 });
log("upload page visible");

const jobId = await page.evaluate(async () => {
  const m = await import("/src/local/jobs.ts");
  async function asFile(url, name, type) {
    const r = await fetch(url);
    const blob = await r.blob();
    return new File([blob], name, { type });
  }
  const audio = await asFile("/__readme_fixtures__/studio.mp3", "studio.mp3", "audio/mpeg");
  const v1 = await asFile("/__readme_fixtures__/take-1.mp4", "take-1.mp4", "video/mp4");
  const v2 = await asFile("/__readme_fixtures__/take-2.mp4", "take-2.mp4", "video/mp4");
  return m.createJob(
    [
      { file: v1, handle: null },
      { file: v2, handle: null },
    ],
    { file: audio, handle: null },
    { title: "E2E long-form", mode: "longform" },
  );
});
log(`job created: ${jobId}`);

let synced = null;
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  const j = await page.evaluate(async (id) => {
    const m = await import("/src/local/jobs.ts");
    return (await m.jobsDb.getJob(id)) ?? null;
  }, jobId);
  if (j?.status === "synced") {
    synced = j;
    break;
  }
  if (j?.status === "failed") throw new Error(`sync failed: ${j.error}`);
  await new Promise((r) => setTimeout(r, 500));
}
if (!synced) throw new Error("sync didn't finish in 120s");
log(`synced: chunks=${synced.chunks?.length ?? 0}`);

// Force-seed 6 chunks if detection produced fewer (studio.mp3 is short
// and contains no silences for the detector to find).
if (!synced.chunks || synced.chunks.length < 4) {
  await page.evaluate(async (id) => {
    const m = await import("/src/local/jobs.ts");
    const j = await m.jobsDb.getJob(id);
    const dur = j.durationS ?? 30;
    // Compress 25 chunks into the available master-audio span. Mix
    // long + short so the strip-vs-on-demand tier picker is exercised.
    const N = 25;
    const usable = dur - 0.5;
    const base = (usable * 1000) / N;
    const chunks = [];
    let cursor = 250;
    for (let i = 0; i < N; i++) {
      const lenMs = Math.max(400, Math.round(base * (i % 3 === 0 ? 0.5 : 1.0)));
      const endMs = Math.min(dur * 1000 - 50, cursor + lenMs);
      if (endMs <= cursor + 100) break;
      chunks.push({
        id: `chunk-${cursor}-${endMs}`,
        startMs: cursor,
        endMs,
        detectedBpm: 120,
        bpmOctaveShift: 0,
        effectiveBpm: 120,
        beatsPerBar: 4,
        accepted: true,
        trimMode: "auto",
      });
      cursor = endMs + 50;
    }
    const arrangement = chunks.map((c, i) => ({
      id: `arr-${c.id}-${Date.now()}-${i}`,
      chunkId: c.id,
    }));
    await m.jobsDb.updateJob(id, { chunks, arrangement });
  }, jobId);
  log("seeded synthetic chunks (mixed lengths) + arrangement");
  const post = await page.evaluate(async (id) => {
    const m = await import("/src/local/jobs.ts");
    const j = await m.jobsDb.getJob(id);
    return {
      durationS: j.durationS,
      chunks: j.chunks?.length,
      arr: j.arrangement?.length,
      ranges: j.chunks?.map((c) => `${c.startMs / 1000}-${c.endMs / 1000}`),
    };
  }, jobId);
  log(`post-seed: ${JSON.stringify(post)}`);
}

// Desktop arrange.
await page.goto(`${BASE}/job/${jobId}/arrange`, { waitUntil: "networkidle" });
await page.waitForSelector("text=/CONTACT SHEET/i", { timeout: 15_000 });
await page.waitForTimeout(3_500); // let polaroids develop fully

await page.screenshot({ path: path.join(OUT, "01-arrange-desktop.png") });
log("01-arrange-desktop");

// Take a tight crop of the filmstreifen so the visual can be assessed
// at full resolution without the surrounding chrome.
{
  const strip = await page
    .locator(".overflow-x-auto.overflow-y-hidden.bg-sunken")
    .first();
  const box = await strip.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "01b-arrange-filmstrip.png"),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    log("01b-arrange-filmstrip (close-up)");
  }
}

// Click +ADD on the first polaroid (insert duplicate at end).
await page.locator('button[aria-label="Insert chunk into arrangement"]').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, "02-arrange-after-add.png") });
log("02-arrange-after-add");

// Click +ADD many more times to cause filmstrip overflow → mini-map.
for (let i = 0; i < 8; i++) {
  await page
    .locator('button[aria-label="Insert chunk into arrangement"]')
    .nth(i % 3)
    .click();
  await page.waitForTimeout(60);
}
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "02b-arrange-overflow.png") });
log("02b-arrange-overflow (mini-map should appear)");

// Crop the strip + minimap region.
{
  const strip = await page
    .locator(".overflow-x-auto.overflow-y-hidden.bg-sunken")
    .first();
  const box = await strip.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "02c-arrange-overflow-strip.png"),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height + 40 },
    });
    log("02c-arrange-overflow-strip (close-up with minimap)");
  }
}

// Click on the third frame to focus it.
const frames = page.locator('main button[title^="#"]');
const frameCount = await frames.count();
if (frameCount >= 3) {
  await frames.nth(2).click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: path.join(OUT, "03-arrange-focused.png") });
log(`03-arrange-focused (frames: ${frameCount})`);

// Crop the bottom transport bar to assess the inline inspector layout.
{
  const bar = await page.locator(".bg-paper-hi.border-t.border-rule").last();
  const box = await bar.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "03b-transport-bar.png"),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    log("03b-transport-bar (inspector should be inline)");
  }
  // Diagnostic: which inspector buttons are present + visible?
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .filter((b) => /Drop|Dup|×2|^◀$|^▶$/.test(b.textContent ?? ""))
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          txt: b.textContent?.trim().slice(0, 12),
          x: Math.round(r.x),
          w: Math.round(r.width),
          right: Math.round(r.right),
        };
      }),
  );
  console.log("[e2e] inspector buttons:", JSON.stringify(buttons));
}

// Move insertion cursor to the leftmost position (click leading cursor).
// All cursor buttons are aria-label="Set insertion point".
const cursors = page.locator('button[aria-label="Set insertion point"]');
await cursors.first().click();
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, "04-arrange-cursor-leading.png") });
log("04-arrange-cursor-leading");

// Mobile layout.
await page.setViewportSize({ width: 414, height: 900 });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "05-arrange-mobile.png") });
log("05-arrange-mobile");

// Mobile minimap close-up (overflow guaranteed at this viewport).
{
  const strip = await page
    .locator(".overflow-x-auto.overflow-y-hidden.bg-sunken")
    .first();
  const box = await strip.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "05b-mobile-minimap.png"),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height + 30 },
    });
    log("05b-mobile-minimap");
  }
}

// Mobile inspector visible — focus a frame to expand it.
const mobileFrames = page.locator('main button[title^="#"]');
if ((await mobileFrames.count()) > 0) {
  await mobileFrames.first().click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: path.join(OUT, "06-arrange-mobile-inspector.png") });
log("06-arrange-mobile-inspector");

// Continue → Editor.
await page.setViewportSize({ width: 1456, height: 900 });
await page.waitForTimeout(400);
await page.click('button:has-text("Continue → Editor")');
await page.waitForURL(`${BASE}/job/${jobId}/edit`, { timeout: 10_000 });
// Manual poll — playwright's waitForFunction with async returns is
// flaky (Promises read as truthy regardless of resolved value).
let settledSeg = 0;
const editorT0 = Date.now();
while (Date.now() - editorT0 < 15_000) {
  // Read via window.__lastEditorState (set by the Editor.tsx debug
   // logging hook) so we observe the SAME store instance the editor
   // mounts; Vite dev-server can hand back distinct module instances
   // for dynamic imports vs static ones.
  settledSeg = await page.evaluate(() => {
    return window.__lastEditorSegments ?? 0;
  });
  if (settledSeg > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
log(`editor settled: ${settledSeg} segments`);

await page.screenshot({ path: path.join(OUT, "07-editor-after-arrange.png") });
log("07-editor-after-arrange");

// Zoom into the audio lane so the segment shading + splice marks are
// visible. We crop a strip across the bottom of the editor.
{
  const audioLane = await page.locator("canvas").last();
  const box = await audioLane.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(OUT, "07b-editor-audio-lane.png"),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    log("07b-editor-audio-lane (segment shading should show here)");
  }
}

// Verify segment state in the editor store. We use the
// window.__lastEditorSegments / __lastEditorTrim hooks the Editor
// page sets — Vite dev hands back distinct module instances for
// dynamic imports, so reading the store via a fresh import gets a
// different (default) zustand instance.
const editorState = await page.evaluate(async (id) => {
  const jm = await import("/src/local/jobs.ts");
  const j = await jm.jobsDb.getJob(id);
  return {
    segments: window.__lastEditorSegments ?? 0,
    trim: window.__lastEditorTrim ?? null,
    persistedJob: {
      mode: j?.mode,
      arrangement: j?.arrangement?.length,
      chunks: j?.chunks?.length,
      bpm: j?.bpm?.value,
    },
  };
}, jobId);
console.log("[e2e] persistedJob:", JSON.stringify(editorState.persistedJob));
log(
  `editor: segments=${editorState.segments} trim=${editorState.trim?.in?.toFixed(2)}-${editorState.trim?.out?.toFixed(2)}`,
);
if (editorState.segments === 0) {
  throw new Error("editor did not receive arrangementSegments — Phase 7 wiring broken");
}
log(`✓ editor received ${editorState.segments} arrangement segments`);

// Drive the timeline to confirm playback works through the segment hops.
// Just press space — Web Audio context can't be resumed in headless,
// but the play/pause toggle should still update the store.
await page.keyboard.press("Space");
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, "08-editor-playing.png") });
log("08-editor-playing");

// Editor mobile.
await page.setViewportSize({ width: 414, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, "09-editor-mobile.png") });
log("09-editor-mobile");

// Quick verification of the IDB thumbnail cache: count how many
// `chunk-thumbnails` rows landed in IDB after the user touched
// every chunk on the page.
await page.setViewportSize({ width: 1456, height: 900 });
await page.goto(`${BASE}/job/${jobId}/arrange`, { waitUntil: "networkidle" });
await page.waitForTimeout(3_000);
const cacheSize = await page.evaluate(async () => {
  return await new Promise((resolve) => {
    const req = indexedDB.open("videoaudiosync", 4);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chunk-thumbnails")) {
        resolve({ ok: false, reason: "store missing" });
        return;
      }
      const tx = db.transaction("chunk-thumbnails", "readonly");
      const cnt = tx.objectStore("chunk-thumbnails").count();
      cnt.onsuccess = () => resolve({ ok: true, count: cnt.result });
      cnt.onerror = () => resolve({ ok: false, reason: "count error" });
    };
    req.onerror = () => resolve({ ok: false, reason: "open error" });
    setTimeout(() => resolve({ ok: false, reason: "timeout" }), 5000);
  });
});
console.log("[e2e] thumbnail cache:", JSON.stringify(cacheSize));

await browser.close();
log("done");
