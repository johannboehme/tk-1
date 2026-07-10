import { describe, it, expect } from "vitest";
import {
  DEMO_SONG,
  buildDemoScore,
  renderDemoSongPcm,
  songDurationS,
} from "./demo-song";

describe("demo song score", () => {
  it("computes the song duration from the spec", () => {
    // 8 bars × 4 beats at 112 BPM.
    expect(songDurationS(DEMO_SONG)).toBeCloseTo((8 * 4 * 60) / 112, 6);
  });

  it("places one kick on every beat", () => {
    const score = buildDemoScore(DEMO_SONG);
    const kicks = score.filter((n) => n.voice === "kick");
    expect(kicks).toHaveLength(DEMO_SONG.bars * DEMO_SONG.beatsPerBar);
    const beat = 60 / DEMO_SONG.bpm;
    kicks.forEach((k, i) => {
      expect(k.atS).toBeCloseTo(i * beat, 6);
    });
  });

  it("keeps every note inside the song and sorted by start time", () => {
    const score = buildDemoScore(DEMO_SONG);
    const dur = songDurationS(DEMO_SONG);
    expect(score.length).toBeGreaterThan(0);
    let prev = -1;
    for (const n of score) {
      expect(n.atS).toBeGreaterThanOrEqual(0);
      expect(n.atS).toBeLessThan(dur);
      expect(n.durS).toBeGreaterThan(0);
      expect(n.gain).toBeGreaterThan(0);
      expect(n.gain).toBeLessThanOrEqual(1);
      expect(n.atS).toBeGreaterThanOrEqual(prev);
      prev = n.atS;
    }
  });

  it("uses all four voices", () => {
    const voices = new Set(buildDemoScore(DEMO_SONG).map((n) => n.voice));
    expect(voices).toEqual(new Set(["kick", "bass", "lead", "hat"]));
  });
});

describe("renderDemoSongPcm", () => {
  it("renders exactly duration × sampleRate finite samples", () => {
    const pcm = renderDemoSongPcm(DEMO_SONG);
    expect(pcm.length).toBe(
      Math.round(songDurationS(DEMO_SONG) * DEMO_SONG.sampleRate),
    );
    for (let i = 0; i < pcm.length; i += 997) {
      expect(Number.isFinite(pcm[i])).toBe(true);
    }
  });

  it("produces audible, non-clipping audio", () => {
    const pcm = renderDemoSongPcm(DEMO_SONG);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
      sumSq += pcm[i] * pcm[i];
    }
    const rms = Math.sqrt(sumSq / pcm.length);
    expect(peak).toBeLessThanOrEqual(0.95);
    expect(peak).toBeGreaterThan(0.3);
    expect(rms).toBeGreaterThan(0.02);
  });

  it("has energy right at the first kick", () => {
    const pcm = renderDemoSongPcm(DEMO_SONG);
    const window = pcm.subarray(0, Math.floor(0.05 * DEMO_SONG.sampleRate));
    let sumSq = 0;
    for (let i = 0; i < window.length; i++) sumSq += window[i] * window[i];
    expect(Math.sqrt(sumSq / window.length)).toBeGreaterThan(0.05);
  });

  it("is deterministic", () => {
    const a = renderDemoSongPcm(DEMO_SONG);
    const b = renderDemoSongPcm(DEMO_SONG);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 501) {
      expect(a[i]).toBe(b[i]);
    }
  });
});
