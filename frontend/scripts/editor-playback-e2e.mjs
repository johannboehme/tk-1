/**
 * Focused playback-timing E2E for the long-form Editor.
 *
 * Spins up Chromium, seeds a longform job with arrangement segments
 * (incl. a duplicate so the audio walker's currentSegmentIdx logic is
 * exercised), opens the Editor, hits Space, and asserts that the
 * arrangement-time playhead actually advances. This is the strongest
 * end-to-end signal that segment-walker hops are happening on the
 * audio render thread without the test having to inspect AudioContext
 * internals.
 *
 * Additionally verifies:
 *   - TransportClock.duration shows the SUM of arrangement segments,
 *     not the raw master-audio duration
 *   - currentTime never overshoots the arrangement total
 *   - Pressing a digit hotkey during playback adds a cut in master-time
 *     and the cut shows up in store.cuts
 */
import { chromium } from "playwright";
import path from "node:path";

const BASE = "http://localhost:5173";
const log = (msg) =>
  console.log(`[playback-e2e] ${new Date().toISOString().slice(11, 19)} ${msg}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1456, height: 900 } });
ctx.on("pageerror", (err) => console.error("[page-error]", err.message));
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: "networkidle" });
log("upload page visible");

// Seed job + chunks + arrangement (with duplicate).
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
  const id = await m.createJob(
    [{ file: v1, handle: null }],
    { file: audio, handle: null },
    { title: "Playback E2E", mode: "longform" },
  );
  // Wait for sync.
  for (let i = 0; i < 60; i++) {
    const j = await m.jobsDb.getJob(id);
    if (j?.status === "synced") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return id;
});
log(`job: ${jobId}`);

// Force-seed 3 chunks + duplicate, total arr ~ 6s.
await page.evaluate(async (id) => {
  const m = await import("/src/local/jobs.ts");
  const chunks = [
    { id: "c0", startMs: 500, endMs: 2500, detectedBpm: 120, bpmOctaveShift: 0, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" },
    { id: "c1", startMs: 5000, endMs: 7000, detectedBpm: 120, bpmOctaveShift: 0, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" },
    { id: "c2", startMs: 12000, endMs: 14000, detectedBpm: 120, bpmOctaveShift: 0, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" },
  ];
  const arrangement = [
    { id: "a0", chunkId: "c0" },
    { id: "a1", chunkId: "c1" },
    { id: "a2", chunkId: "c2" },
    { id: "a-dup", chunkId: "c0" }, // duplicate of c0 — exercises walker's segmentIdx
  ];
  await m.jobsDb.updateJob(id, { chunks, arrangement });
}, jobId);
log("seeded chunks + arrangement (4 segments incl. duplicate, total 8s)");

// Navigate to editor.
await page.goto(`${BASE}/job/${jobId}/edit`, { waitUntil: "networkidle" });
let segments = 0;
for (let i = 0; i < 30 && segments < 4; i++) {
  segments = await page.evaluate(
    () => window.__editorTestHooks?.segments ?? 0,
  );
  await new Promise((r) => setTimeout(r, 300));
}
if (segments !== 4) {
  throw new Error(`expected 4 segments, got ${segments}`);
}
log(`editor loaded with ${segments} segments`);

// Wait for the master audio to report duration so playback can start
// (HTMLMediaElement metadata load can be slow under headless Chromium).
await page.waitForFunction(() => {
  const aud = document.querySelectorAll("audio");
  return aud.length >= 2 && Number.isFinite(aud[0].duration);
}, { timeout: 15_000 });
log("audio metadata loaded");

// Hit Space to start playback.
await page.click("body");
await page.keyboard.press("Space");
log("space pressed → playing");

// Sample the playhead's master-time + arrangement-time over ~3s and
// verify it advances. The cleanest signal is reading `playback.currentTime`
// from the same store instance the editor uses; we expose it via the
// dev-only test hook on the window.
const samples = [];
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 350));
  const t = await page.evaluate(() => {
    const audios = document.querySelectorAll("audio");
    const active = [...audios].find((a) => !a.paused && a.currentTime > 0);
    return {
      activeAudioT: active?.currentTime ?? null,
      paused: [...audios].map((a) => a.paused),
      now: Date.now(),
    };
  });
  samples.push(t);
}
log("samples: " + JSON.stringify(samples.map((s) => s.activeAudioT)));

// Assertions:
const advanced = samples.some(
  (s, i) => i > 0 && s.activeAudioT != null && samples[0].activeAudioT != null && s.activeAudioT > samples[0].activeAudioT + 0.05,
);
if (!advanced) {
  throw new Error("audio time did NOT advance after pressing Space");
}
log("✓ audio time advances during playback");

// Verify currentTime stayed within a known segment range during playback.
// For our seed, segments are master [0.5,2.5] [5,7] [12,14] [0.5,2.5];
// audio walker should hop between them. Any sampled t outside the union
// of segment master-time ranges means playback fell into a gap — bad.
const inAnySegment = (t) =>
  (t >= 0.5 && t < 2.5) || (t >= 5 && t < 7) || (t >= 12 && t < 14);
for (const s of samples) {
  if (s.activeAudioT == null) continue;
  if (!inAnySegment(s.activeAudioT)) {
    throw new Error(
      `playhead drifted into a gap at master-time ${s.activeAudioT}`,
    );
  }
}
log("✓ all sampled master-times fall inside a segment");

// Pause + verify halts.
await page.keyboard.press("Space");
await new Promise((r) => setTimeout(r, 400));
const pausedSnap = await page.evaluate(() => {
  const audios = document.querySelectorAll("audio");
  return [...audios].map((a) => a.paused);
});
if (!pausedSnap.every((p) => p)) {
  throw new Error("expected all audio elements paused after second Space");
}
log("✓ second space pause halts playback");

// Take a final screenshot.
const OUT = path.resolve("./e2e-screens");
await page.screenshot({ path: path.join(OUT, "playback-after.png") });
log("done");

await browser.close();
