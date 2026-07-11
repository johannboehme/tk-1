import { describe, it, expect } from "vitest";
import {
  DEMO_SONG,
  DEMO_SESSION,
  buildDemoScore,
  buildDemoSessionScore,
  renderDemoSongPcm,
  renderDemoSessionPcm,
  sessionDurationS,
  songDurationS,
  type DemoSectionStyle,
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

describe("demo session score (long-form)", () => {
  it("computes the session duration from lead-in, sections and gaps", () => {
    const barS = DEMO_SESSION.beatsPerBar * (60 / DEMO_SESSION.bpm);
    let expected = DEMO_SESSION.leadInS;
    for (const s of DEMO_SESSION.sections) {
      expected += (s.bars + s.gapBars) * barS;
    }
    expect(sessionDurationS(DEMO_SESSION)).toBeCloseTo(expected, 6);
  });

  it("lays the sections out sequentially with their silence gaps", () => {
    const { sections } = buildDemoSessionScore(DEMO_SESSION);
    expect(sections).toHaveLength(DEMO_SESSION.sections.length);
    const barS = DEMO_SESSION.beatsPerBar * (60 / DEMO_SESSION.bpm);
    let cursor = DEMO_SESSION.leadInS;
    for (const [i, spec] of DEMO_SESSION.sections.entries()) {
      expect(sections[i].style).toBe(spec.style);
      expect(sections[i].startS).toBeCloseTo(cursor, 6);
      expect(sections[i].endS).toBeCloseTo(cursor + spec.bars * barS, 6);
      cursor = sections[i].endS + spec.gapBars * barS;
    }
  });

  it("keeps ONE tempo: every note sits on the 16th grid of the session BPM", () => {
    const { notes } = buildDemoSessionScore(DEMO_SESSION);
    const sixteenth = 60 / DEMO_SESSION.bpm / 4;
    for (const n of notes) {
      const gridPos = (n.atS - DEMO_SESSION.leadInS) / sixteenth;
      expect(Math.abs(gridPos - Math.round(gridPos))).toBeLessThan(1e-6);
    }
  });

  it("keeps every note inside its own section (nothing bleeds into a gap)", () => {
    const { notes, sections } = buildDemoSessionScore(DEMO_SESSION);
    for (const n of notes) {
      const home = sections.find(
        (s) => n.atS >= s.startS - 1e-9 && n.atS < s.endS - 1e-9,
      );
      expect(home, `note at ${n.atS}s outside every section`).toBeDefined();
    }
  });

  it("gives each section style its own flavour", () => {
    const { notes, sections } = buildDemoSessionScore(DEMO_SESSION);
    const styles = new Map(sections.map((s) => [s.style, s] as const));
    const notesIn = (style: DemoSectionStyle) => {
      const s = styles.get(style)!;
      return notes.filter((n) => n.atS >= s.startS && n.atS < s.endS);
    };
    // Drums section: kicks but no bass, no lead.
    const drums = notesIn("drums");
    expect(drums.some((n) => n.voice === "kick")).toBe(true);
    expect(drums.some((n) => n.voice === "bass")).toBe(false);
    expect(drums.some((n) => n.voice === "lead")).toBe(false);
    // Bass groove: bass present, no lead.
    const groove = notesIn("bass-groove");
    expect(groove.some((n) => n.voice === "bass")).toBe(true);
    expect(groove.some((n) => n.voice === "lead")).toBe(false);
    // Full: all four voices.
    expect(new Set(notesIn("full").map((n) => n.voice))).toEqual(
      new Set(["kick", "bass", "lead", "hat"]),
    );
    // Sparse outro: no kick — a quiet noodle.
    const sparse = notesIn("sparse");
    expect(sparse.length).toBeGreaterThan(0);
    expect(sparse.some((n) => n.voice === "kick")).toBe(false);
  });
});

describe("renderDemoSessionPcm", () => {
  it("renders exactly duration × sampleRate samples", () => {
    const pcm = renderDemoSessionPcm(DEMO_SESSION);
    expect(pcm.length).toBe(
      Math.round(sessionDurationS(DEMO_SESSION) * DEMO_SESSION.sampleRate),
    );
  });

  it("is silent in the gaps and audible in the sections (what Triage detects)", () => {
    const pcm = renderDemoSessionPcm(DEMO_SESSION);
    const sr = DEMO_SESSION.sampleRate;
    const { sections } = buildDemoSessionScore(DEMO_SESSION);
    const rms = (fromS: number, toS: number) => {
      const a = Math.max(0, Math.floor(fromS * sr));
      const b = Math.min(pcm.length, Math.floor(toS * sr));
      let sum = 0;
      for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
      return Math.sqrt(sum / Math.max(1, b - a));
    };
    for (const [i, s] of sections.entries()) {
      expect(rms(s.startS, s.endS), `section ${i} too quiet`).toBeGreaterThan(0.02);
      const gapEnd =
        i + 1 < sections.length
          ? sections[i + 1].startS
          : sessionDurationS(DEMO_SESSION);
      // 0.5 s ring-out margin for the exponential envelopes.
      if (gapEnd - s.endS > 0.8) {
        expect(
          rms(s.endS + 0.5, gapEnd - 0.05),
          `gap after section ${i} not silent`,
        ).toBeLessThan(0.003);
      }
    }
  });

  it("is deterministic", () => {
    const a = renderDemoSessionPcm(DEMO_SESSION);
    const b = renderDemoSessionPcm(DEMO_SESSION);
    for (let i = 0; i < a.length; i += 733) {
      expect(a[i]).toBe(b[i]);
    }
  });
});
