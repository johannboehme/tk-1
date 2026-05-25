/**
 * Unit-Tests für die Triage-Store-Actions splitChunkAt / joinChunks /
 * insertChunkAtPlayhead — die Manual-Edit-Surface, die der User auch
 * dann braucht, wenn der Silence-Detection-Pass nicht das richtige tut
 * (z.B. ein "stilles" Intermezzo soll als Chunk drin bleiben, oder ein
 * langer Take soll musikalisch in zwei Hälften geteilt werden).
 *
 * Wir testen die reinen State-Transitions; die UI-Schicht (Inspector,
 * Shortcuts) hängt sich nur dran.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useTriageStore, DEFAULT_SILENCE_CONFIG_STORE } from "./triage-store";
import type { Chunk } from "../../storage/jobs-db";

function makeChunk(overrides: Partial<Chunk> & Pick<Chunk, "id" | "startMs" | "endMs">): Chunk {
  return {
    bpmOctaveShift: 0,
    effectiveBpm: 120,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
    ...overrides,
  };
}

function seed(chunks: Chunk[], opts?: { audioDuration?: number; jobBpm?: number }) {
  useTriageStore.getState().reset();
  useTriageStore.setState({
    jobId: "test",
    audioDuration: opts?.audioDuration ?? 600,
    pcm: new Float32Array(0),
    pcmSampleRate: 22050,
    envelope: new Float32Array(0),
    envelopeHz: 10,
    cams: [],
    chunks,
    silenceConfig: DEFAULT_SILENCE_CONFIG_STORE,
    jobBpm: opts?.jobBpm ? { value: opts.jobBpm, confidence: 0.9, manualOverride: false } : null,
    detectedBpm: null,
    beatsPerBar: 4,
    barOffsetBeats: 0,
    beatPhaseS: 0,
  });
}

describe("triage-store · splitChunkAt", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("splits one chunk into two adjacent chunks at the given master-time", () => {
    const chunk = makeChunk({
      id: "c1",
      startMs: 1000,
      endMs: 5000,
      detectedBpm: 100,
      audioStartMs: 1200,
    });
    seed([chunk]);
    const newId = useTriageStore.getState().splitChunkAt("c1", 3000);
    const result = useTriageStore.getState().chunks.sort((a, b) => a.startMs - b.startMs);
    expect(result).toHaveLength(2);
    expect(result[0].startMs).toBe(1000);
    expect(result[0].endMs).toBe(3000);
    expect(result[1].startMs).toBe(3000);
    expect(result[1].endMs).toBe(5000);
    expect(newId).toBe(result[1].id);
    expect(result[0].id).toBe("c1");
    expect(result[1].id).not.toBe("c1");
  });

  it("inherits accepted, bpmOctaveShift, effectiveBpm, detectedBpm to both halves", () => {
    seed([
      makeChunk({
        id: "c1",
        startMs: 0,
        endMs: 4000,
        accepted: false,
        bpmOctaveShift: 1,
        detectedBpm: 90,
        effectiveBpm: 180,
      }),
    ]);
    useTriageStore.getState().splitChunkAt("c1", 2000);
    const [a, b] = useTriageStore.getState().chunks.sort((x, y) => x.startMs - y.startMs);
    expect(a.accepted).toBe(false);
    expect(b.accepted).toBe(false);
    expect(a.bpmOctaveShift).toBe(1);
    expect(b.bpmOctaveShift).toBe(1);
    expect(a.detectedBpm).toBe(90);
    expect(b.detectedBpm).toBe(90);
    expect(a.effectiveBpm).toBe(180);
    expect(b.effectiveBpm).toBe(180);
  });

  it("derives both halves' audioStartMs from the original grid (no inheritance, no click-point)", () => {
    // Original chunk: anchor=1000ms, span 1000-5000, BPM=120 4/4 → msPerBar=2000ms.
    // Grid is ..., 1000, 3000, 5000, 7000, ... Split at 3500ms.
    // Left half [1000, 3500): first grid bar ≥ 1000 = 1000.
    // Right half [3500, 5000]: first grid bar ≥ 3500 = 5000.
    seed([
      makeChunk({
        id: "c1",
        startMs: 1000,
        endMs: 5000,
        audioStartMs: 1000,
        effectiveBpm: 120,
        beatsPerBar: 4,
      }),
    ]);
    useTriageStore.getState().splitChunkAt("c1", 3500);
    const [a, b] = useTriageStore.getState().chunks.sort((x, y) => x.startMs - y.startMs);
    expect(a.audioStartMs).toBe(1000);
    expect(b.audioStartMs).toBe(5000);
  });

  it("right half anchor lands on the first bar boundary of the original grid past splitMs", () => {
    // Anchor=1137ms (deliberately not on a round number), msPerBar=2000ms.
    // Grid: 1137, 3137, 5137, 7137, ... Split at 4000.
    // Left [1000, 4000): bars in range 1137, 3137 → first = 1137.
    // Right [4000, 9000]: first bar ≥ 4000 = 5137.
    seed([
      makeChunk({
        id: "c1",
        startMs: 1000,
        endMs: 9000,
        audioStartMs: 1137,
        effectiveBpm: 120,
        beatsPerBar: 4,
      }),
    ]);
    useTriageStore.getState().splitChunkAt("c1", 4000);
    const [a, b] = useTriageStore.getState().chunks.sort((x, y) => x.startMs - y.startMs);
    expect(a.audioStartMs).toBe(1137);
    expect(b.audioStartMs).toBe(5137);
  });

  it("origin snapshots reflect the newly-computed anchors, not the click point", () => {
    seed([
      makeChunk({
        id: "c1",
        startMs: 1000,
        endMs: 9000,
        audioStartMs: 1137,
        effectiveBpm: 120,
        beatsPerBar: 4,
      }),
    ]);
    useTriageStore.getState().splitChunkAt("c1", 4000);
    const [a, b] = useTriageStore.getState().chunks.sort((x, y) => x.startMs - y.startMs);
    expect(a.originalAudioStartMs).toBe(1137);
    expect(b.originalAudioStartMs).toBe(5137);
  });

  it("falls back to splitMs as the right-half anchor when effectiveBpm is unknown", () => {
    // Cold-start case before global BPM is known. Don't crash, don't divide-by-zero.
    seed([
      makeChunk({
        id: "c1",
        startMs: 1000,
        endMs: 5000,
        audioStartMs: 1200,
        effectiveBpm: 0,
        detectedBpm: undefined,
      }),
    ]);
    useTriageStore.getState().splitChunkAt("c1", 3000);
    const [a, b] = useTriageStore.getState().chunks.sort((x, y) => x.startMs - y.startMs);
    expect(a.audioStartMs).toBe(1200);
    expect(b.audioStartMs).toBe(3000);
  });

  it("returns null + leaves state untouched if atMs is outside chunk bounds", () => {
    seed([makeChunk({ id: "c1", startMs: 1000, endMs: 5000 })]);
    expect(useTriageStore.getState().splitChunkAt("c1", 500)).toBeNull();
    expect(useTriageStore.getState().splitChunkAt("c1", 6000)).toBeNull();
    expect(useTriageStore.getState().chunks).toHaveLength(1);
  });

  it("rejects degenerate splits (touching either edge within 50ms)", () => {
    seed([makeChunk({ id: "c1", startMs: 1000, endMs: 5000 })]);
    expect(useTriageStore.getState().splitChunkAt("c1", 1010)).toBeNull();
    expect(useTriageStore.getState().splitChunkAt("c1", 4990)).toBeNull();
    expect(useTriageStore.getState().chunks).toHaveLength(1);
  });

  it("focuses the right half if the split target was the focused chunk", () => {
    seed([makeChunk({ id: "c1", startMs: 1000, endMs: 5000 })]);
    useTriageStore.getState().focusChunk("c1");
    const newId = useTriageStore.getState().splitChunkAt("c1", 3000);
    expect(useTriageStore.getState().focusedChunkId).toBe(newId);
  });
});

describe("triage-store · joinChunks", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("merges focused chunk with its predecessor (direction = 'prev')", () => {
    seed([
      makeChunk({ id: "a", startMs: 0, endMs: 2000, accepted: true, audioStartMs: 100 }),
      makeChunk({ id: "b", startMs: 2200, endMs: 4000, accepted: false, audioStartMs: 2300 }),
    ]);
    useTriageStore.getState().focusChunk("b");
    useTriageStore.getState().joinChunks("b", "prev");
    const chunks = useTriageStore.getState().chunks;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startMs).toBe(0);
    expect(chunks[0].endMs).toBe(4000);
    // OR — if either side was kept, the merged chunk is kept too. Conservative.
    expect(chunks[0].accepted).toBe(true);
    // Earlier audioStartMs wins so the bar-grid stays musical.
    expect(chunks[0].audioStartMs).toBe(100);
  });

  it("merges focused chunk with its successor (direction = 'next')", () => {
    seed([
      makeChunk({ id: "a", startMs: 0, endMs: 2000 }),
      makeChunk({ id: "b", startMs: 2500, endMs: 4000 }),
    ]);
    useTriageStore.getState().joinChunks("a", "next");
    const chunks = useTriageStore.getState().chunks;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startMs).toBe(0);
    expect(chunks[0].endMs).toBe(4000);
  });

  it("focuses the merged chunk", () => {
    seed([
      makeChunk({ id: "a", startMs: 0, endMs: 2000 }),
      makeChunk({ id: "b", startMs: 2500, endMs: 4000 }),
    ]);
    useTriageStore.getState().focusChunk("b");
    useTriageStore.getState().joinChunks("b", "prev");
    const focused = useTriageStore.getState().focusedChunkId;
    expect(focused).not.toBeNull();
    expect(useTriageStore.getState().chunks[0].id).toBe(focused);
  });

  it("does nothing when there is no neighbor in the requested direction", () => {
    seed([makeChunk({ id: "only", startMs: 0, endMs: 2000 })]);
    useTriageStore.getState().joinChunks("only", "prev");
    useTriageStore.getState().joinChunks("only", "next");
    expect(useTriageStore.getState().chunks).toHaveLength(1);
  });
});

describe("triage-store · insertChunkAtPlayhead", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("creates a new chunk at the playhead with default duration when there is room", () => {
    seed([makeChunk({ id: "a", startMs: 0, endMs: 2000 })]);
    useTriageStore.setState((s) => ({
      playback: { ...s.playback, currentTime: 5 },
    }));
    const id = useTriageStore.getState().insertChunkAtPlayhead();
    expect(id).not.toBeNull();
    const chunks = useTriageStore.getState().chunks.sort((x, y) => x.startMs - y.startMs);
    expect(chunks).toHaveLength(2);
    const inserted = chunks.find((c) => c.id === id)!;
    expect(inserted.accepted).toBe(true);
    expect(inserted.startMs).toBe(5000);
    expect(inserted.endMs).toBeGreaterThan(5000);
  });

  it("trims the new chunk to the available silence gap if the default would overlap", () => {
    seed([
      makeChunk({ id: "a", startMs: 0, endMs: 2000 }),
      makeChunk({ id: "b", startMs: 4000, endMs: 8000 }),
    ]);
    // Playhead at 2.5s — gap is [2000, 4000], available 1.5s after 2.5s.
    useTriageStore.setState((s) => ({ playback: { ...s.playback, currentTime: 2.5 } }));
    const id = useTriageStore.getState().insertChunkAtPlayhead();
    expect(id).not.toBeNull();
    const inserted = useTriageStore.getState().chunks.find((c) => c.id === id)!;
    expect(inserted.startMs).toBe(2500);
    expect(inserted.endMs).toBeLessThanOrEqual(4000);
  });

  it("returns null if the playhead is inside an existing chunk", () => {
    seed([makeChunk({ id: "a", startMs: 0, endMs: 5000 })]);
    useTriageStore.setState((s) => ({ playback: { ...s.playback, currentTime: 2 } }));
    expect(useTriageStore.getState().insertChunkAtPlayhead()).toBeNull();
    expect(useTriageStore.getState().chunks).toHaveLength(1);
  });

  it("focuses the new chunk so the user can keep editing", () => {
    seed([]);
    useTriageStore.setState((s) => ({ playback: { ...s.playback, currentTime: 3 } }));
    const id = useTriageStore.getState().insertChunkAtPlayhead();
    expect(useTriageStore.getState().focusedChunkId).toBe(id);
  });

  it("uses song-global BPM for the new chunk's effectiveBpm when available", () => {
    seed([], { jobBpm: 100 });
    useTriageStore.setState((s) => ({ playback: { ...s.playback, currentTime: 0 } }));
    const id = useTriageStore.getState().insertChunkAtPlayhead();
    const inserted = useTriageStore.getState().chunks.find((c) => c.id === id)!;
    expect(inserted.effectiveBpm).toBe(100);
  });

  it("snapshots its own bounds as origin so reset is meaningful", () => {
    seed([]);
    useTriageStore.setState((s) => ({ playback: { ...s.playback, currentTime: 5 } }));
    const id = useTriageStore.getState().insertChunkAtPlayhead();
    const inserted = useTriageStore.getState().chunks.find((c) => c.id === id)!;
    expect(inserted.originalStartMs).toBe(5000);
    expect(inserted.originalEndMs).toBe(inserted.endMs);
    expect(inserted.originalAudioStartMs).toBe(5000);
  });
});

describe("triage-store · resetChunk", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("restores boundaries from the origin snapshot", () => {
    seed([
      makeChunk({
        id: "c1",
        startMs: 1500,
        endMs: 4500,
        audioStartMs: 1700,
        originalStartMs: 1000,
        originalEndMs: 5000,
        originalAudioStartMs: 1200,
      }),
    ]);
    useTriageStore.getState().resetChunk("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.startMs).toBe(1000);
    expect(c.endMs).toBe(5000);
    expect(c.audioStartMs).toBe(1200);
    expect(c.trimMode).toBe("auto");
  });

  it("is a no-op for legacy chunks without an origin snapshot", () => {
    seed([
      makeChunk({ id: "c1", startMs: 1500, endMs: 4500, audioStartMs: 1700 }),
    ]);
    useTriageStore.getState().resetChunk("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.startMs).toBe(1500);
    expect(c.endMs).toBe(4500);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// conformChunk — re-fit a chunk's bar-grid phase from its current audio
// range, holding the song-global BPM as the period. Used after manual
// trims/splits placed a chunk in audio whose phase doesn't match its
// stored anchor anymore (mid-take restart, or simply detection that
// landed on a stumble).
// ────────────────────────────────────────────────────────────────────────────

const SR = 22050;

function buildClickTrack(bpm: number, seconds: number, introS = 0): Float32Array {
  const total = Math.round(SR * (seconds + introS));
  const beatPeriod = 60 / bpm;
  const beatStride = Math.round(beatPeriod * SR);
  const clickLen = Math.round(0.005 * SR);
  const introSamples = Math.round(SR * introS);
  const pcm = new Float32Array(total);
  // Noise floor — but only AFTER the silent intro, so analyzeAudio's
  // silent-intro probe (-80 dBFS gate over the first 300 ms) actually
  // fires. Real long-form recordings hit floating-point silence between
  // takes; the synthetic data has to match that behaviour for Conform's
  // first-onset anchor to be testable.
  for (let i = introSamples; i < total; i++) pcm[i] = (Math.random() - 0.5) * 0.01;
  for (let beat = 0; ; beat++) {
    const start = introSamples + beat * beatStride;
    if (start + clickLen >= total) break;
    for (let k = 0; k < clickLen; k++) {
      const env = Math.exp((-k / clickLen) * 4);
      const tone =
        Math.sin((2 * Math.PI * 200 * k) / SR) +
        0.6 * Math.sin((2 * Math.PI * 1500 * k) / SR);
      pcm[start + k] += 0.8 * env * tone;
    }
  }
  return pcm;
}

describe("triage-store · conformChunk", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("anchors at the first onset and trims the leading silence", () => {
    // 0.5 s of true silence + 8 s of 120 BPM clicks. Conform should
    // detect the silent intro, anchor at the first click, and advance
    // startMs to that point — same behaviour as initial detection.
    // Intro is > 300 ms so analyzeAudio's silent-intro probe fires.
    const intro = 0.5;
    const pcm = buildClickTrack(120, 8, intro);
    const totalMs = Math.round((pcm.length / SR) * 1000);
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 0,
          endMs: totalMs,
          audioStartMs: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.setState({ pcm, pcmSampleRate: SR });

    const status = useTriageStore.getState().conformChunk("c1");
    expect(status).toBe("ok");

    const c = useTriageStore.getState().chunks[0];
    const period = 60_000 / 120; // 500 ms per beat
    const msPerBar = period * 4; // 2000

    // Anchor near the first click (500 ms minus the 30 ms backoff +
    // one analysis hop ≈ 470 ms ± 50). Wide tolerance to account for
    // STFT framing.
    expect(c.audioStartMs).toBeGreaterThan(intro * 1000 - 100);
    expect(c.audioStartMs).toBeLessThan(intro * 1000 + 100);

    // Silent intro detected → startMs advances to the anchor (no
    // leading silence kept).
    expect(c.startMs).toBe(c.audioStartMs);

    // endMs sits on a whole bar past the anchor so chunks join
    // seamlessly in the arrangement.
    expect((c.endMs - c.audioStartMs!) % msPerBar).toBe(0);
  });

  it("does not modify any BPM field — BPM is global", () => {
    const intro = 0.13;
    const pcm = buildClickTrack(120, 8, intro);
    const totalMs = Math.round((pcm.length / SR) * 1000);
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 0,
          endMs: totalMs,
          audioStartMs: 0,
          detectedBpm: 121,
          effectiveBpm: 121,
          bpmOctaveShift: 0,
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.setState({ pcm, pcmSampleRate: SR });
    useTriageStore.getState().conformChunk("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.detectedBpm).toBe(121);
    expect(c.effectiveBpm).toBe(121);
    expect(c.bpmOctaveShift).toBe(0);
  });

  it("returns 'no-bpm' when no global BPM is available", () => {
    const pcm = buildClickTrack(120, 4);
    const totalMs = Math.round((pcm.length / SR) * 1000);
    seed([
      makeChunk({
        id: "c1",
        startMs: 0,
        endMs: totalMs,
        audioStartMs: 0,
        effectiveBpm: 0,
        detectedBpm: undefined,
      }),
    ]);
    useTriageStore.setState({ pcm, pcmSampleRate: SR });
    const before = useTriageStore.getState().chunks[0];
    const status = useTriageStore.getState().conformChunk("c1");
    expect(status).toBe("no-bpm");
    const after = useTriageStore.getState().chunks[0];
    expect(after).toEqual(before);
  });

  it("is a no-op on a too-short PCM range (analyzer can't find anything)", () => {
    // No artificial chunk-length cap — we let `analyzeAudio` decide
    // via its own minimums. ~20 ms isn't enough material for even one
    // full STFT frame, so the analyzer returns the empty-shape result
    // (audioStartS = 0). Conform sees no shift to apply and surfaces
    // "unchanged" — chunk is left exactly where it was.
    const pcm = new Float32Array(SR / 50); // ~20 ms
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 0,
          endMs: 20,
          audioStartMs: 0,
          effectiveBpm: 120,
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.setState({ pcm, pcmSampleRate: SR });
    const before = useTriageStore.getState().chunks[0];
    const status = useTriageStore.getState().conformChunk("c1");
    expect(status).toBe("unchanged");
    const after = useTriageStore.getState().chunks[0];
    expect(after).toEqual(before);
  });

  it("returns 'too-short' only when there's no PCM loaded at all", () => {
    seed(
      [makeChunk({ id: "c1", startMs: 0, endMs: 8000, effectiveBpm: 120 })],
      { jobBpm: 120 },
    );
    // Empty pcm — sentinel for "audio not yet decoded".
    useTriageStore.setState({ pcm: new Float32Array(0), pcmSampleRate: SR });
    expect(useTriageStore.getState().conformChunk("c1")).toBe("too-short");
  });


  it("preserves origin snapshots so Reset still pulls back to detection-time", () => {
    const intro = 0.13;
    const pcm = buildClickTrack(120, 8, intro);
    const totalMs = Math.round((pcm.length / SR) * 1000);
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 0,
          endMs: totalMs,
          audioStartMs: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
          originalStartMs: 0,
          originalEndMs: totalMs,
          originalAudioStartMs: 0,
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.setState({ pcm, pcmSampleRate: SR });
    useTriageStore.getState().conformChunk("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.originalStartMs).toBe(0);
    expect(c.originalEndMs).toBe(totalMs);
    expect(c.originalAudioStartMs).toBe(0);
  });

  it("returns 'no-chunk' when the id doesn't match any chunk", () => {
    seed([makeChunk({ id: "c1", startMs: 0, endMs: 1000 })], { jobBpm: 120 });
    expect(useTriageStore.getState().conformChunk("nope")).toBe("no-chunk");
  });

  it("stashes a preConformSnapshot on success that captures the pre-conform bounds", () => {
    const intro = 0.13;
    const pcm = buildClickTrack(120, 8, intro);
    const totalMs = Math.round((pcm.length / SR) * 1000);
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 0,
          endMs: totalMs,
          audioStartMs: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.setState({ pcm, pcmSampleRate: SR });
    useTriageStore.getState().conformChunk("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.preConformSnapshot).toBeDefined();
    expect(c.preConformSnapshot!.startMs).toBe(0);
    expect(c.preConformSnapshot!.endMs).toBe(totalMs);
    expect(c.preConformSnapshot!.audioStartMs).toBe(0);
  });

  it("does not stash a snapshot on no-op outcomes", () => {
    seed([makeChunk({ id: "c1", startMs: 0, endMs: 1000, effectiveBpm: 0 })]);
    useTriageStore.getState().conformChunk("c1");
    expect(useTriageStore.getState().chunks[0].preConformSnapshot).toBeUndefined();
  });
});

describe("triage-store · revertConform", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("restores the chunk's pre-conform state and clears the snapshot", () => {
    const intro = 0.13;
    const pcm = buildClickTrack(120, 8, intro);
    const totalMs = Math.round((pcm.length / SR) * 1000);
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 0,
          endMs: totalMs,
          audioStartMs: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.setState({ pcm, pcmSampleRate: SR });
    useTriageStore.getState().conformChunk("c1");
    // Sanity: conform did mutate the chunk.
    expect(useTriageStore.getState().chunks[0].audioStartMs).not.toBe(0);

    useTriageStore.getState().revertConform("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.startMs).toBe(0);
    expect(c.endMs).toBe(totalMs);
    expect(c.audioStartMs).toBe(0);
    expect(c.preConformSnapshot).toBeUndefined();
  });

  it("is a no-op when the chunk has no snapshot", () => {
    seed([makeChunk({ id: "c1", startMs: 100, endMs: 5000, audioStartMs: 200 })]);
    useTriageStore.getState().revertConform("c1");
    const c = useTriageStore.getState().chunks[0];
    expect(c.startMs).toBe(100);
    expect(c.endMs).toBe(5000);
    expect(c.audioStartMs).toBe(200);
  });

  it("is a no-op when the id doesn't match any chunk", () => {
    seed([makeChunk({ id: "c1", startMs: 0, endMs: 1000 })]);
    expect(() => useTriageStore.getState().revertConform("nope")).not.toThrow();
  });
});

describe("triage-store · snapshot housekeeping", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("splitChunkAt clears the preConformSnapshot on both halves", () => {
    seed([
      makeChunk({
        id: "c1",
        startMs: 0,
        endMs: 8000,
        audioStartMs: 0,
        effectiveBpm: 120,
        beatsPerBar: 4,
        preConformSnapshot: { startMs: 0, endMs: 8000, audioStartMs: 100 },
      }),
    ]);
    useTriageStore.getState().splitChunkAt("c1", 4000);
    const halves = useTriageStore.getState().chunks;
    expect(halves).toHaveLength(2);
    for (const h of halves) {
      expect(h.preConformSnapshot).toBeUndefined();
    }
  });

  it("joinChunks clears the preConformSnapshot on the merged chunk", () => {
    seed([
      makeChunk({
        id: "a",
        startMs: 0,
        endMs: 2000,
        preConformSnapshot: { startMs: 0, endMs: 2000, audioStartMs: 0 },
      }),
      makeChunk({ id: "b", startMs: 2200, endMs: 4000 }),
    ]);
    useTriageStore.getState().joinChunks("a", "next");
    expect(useTriageStore.getState().chunks[0].preConformSnapshot).toBeUndefined();
  });

  it("extendChunkBars clears the preConformSnapshot", () => {
    seed(
      [
        makeChunk({
          id: "c1",
          startMs: 4000,
          endMs: 8000,
          audioStartMs: 4000,
          effectiveBpm: 120,
          beatsPerBar: 4,
          preConformSnapshot: { startMs: 4000, endMs: 8000, audioStartMs: 4000 },
        }),
      ],
      { jobBpm: 120 },
    );
    useTriageStore.getState().extendChunkBars("c1", 1, 0);
    expect(useTriageStore.getState().chunks[0].preConformSnapshot).toBeUndefined();
  });

  it("resetChunk clears the preConformSnapshot", () => {
    seed([
      makeChunk({
        id: "c1",
        startMs: 1500,
        endMs: 4500,
        audioStartMs: 1700,
        originalStartMs: 1000,
        originalEndMs: 5000,
        originalAudioStartMs: 1200,
        preConformSnapshot: { startMs: 1500, endMs: 4500, audioStartMs: 1700 },
      }),
    ]);
    useTriageStore.getState().resetChunk("c1");
    expect(useTriageStore.getState().chunks[0].preConformSnapshot).toBeUndefined();
  });
});

describe("triage-store · setMode", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("loop mode with a focused chunk arms the loop region", () => {
    seed([makeChunk({ id: "c1", startMs: 2000, endMs: 6000 })]);
    useTriageStore.getState().focusChunk("c1");
    useTriageStore.getState().setMode("loop");
    const pb = useTriageStore.getState().playback;
    expect(pb.mode).toBe("loop");
    expect(pb.loop).toEqual({ start: 2, end: 6 });
  });

  it("continue mode clears the loop region", () => {
    seed([makeChunk({ id: "c1", startMs: 2000, endMs: 6000 })]);
    useTriageStore.getState().focusChunk("c1");
    useTriageStore.getState().setMode("continue");
    const pb = useTriageStore.getState().playback;
    expect(pb.mode).toBe("continue");
    expect(pb.loop).toBeNull();
  });

  it("sequence mode clears the loop region", () => {
    seed([makeChunk({ id: "c1", startMs: 2000, endMs: 6000 })]);
    useTriageStore.getState().focusChunk("c1");
    useTriageStore.getState().setMode("sequence");
    const pb = useTriageStore.getState().playback;
    expect(pb.mode).toBe("sequence");
    expect(pb.loop).toBeNull();
  });

  it("focusing a chunk in continue mode does not arm a loop", () => {
    seed([makeChunk({ id: "c1", startMs: 2000, endMs: 6000 })]);
    useTriageStore.getState().setMode("continue");
    useTriageStore.getState().focusChunk("c1");
    const pb = useTriageStore.getState().playback;
    expect(pb.loop).toBeNull();
    expect(pb.currentTime).toBe(2);
  });
});

describe("triage-store · sequence playback", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("sequenceAdvance sets focusedChunkId without touching currentTime", () => {
    seed([
      makeChunk({ id: "a", startMs: 0, endMs: 1000 }),
      makeChunk({ id: "b", startMs: 2000, endMs: 3000 }),
    ]);
    useTriageStore.setState((s) => ({
      playback: { ...s.playback, currentTime: 1.9 },
    }));
    useTriageStore.getState().sequenceAdvance("b");
    expect(useTriageStore.getState().focusedChunkId).toBe("b");
    expect(useTriageStore.getState().playback.currentTime).toBe(1.9);
  });

  it("setPlaying(true) in sequence snaps focus + time to the first kept chunk", () => {
    seed([
      makeChunk({ id: "b", startMs: 5000, endMs: 6000 }),
      makeChunk({ id: "a", startMs: 1000, endMs: 2000 }),
    ]);
    useTriageStore.getState().setMode("sequence");
    useTriageStore.getState().setPlaying(true);
    expect(useTriageStore.getState().focusedChunkId).toBe("a"); // earliest startMs
    expect(useTriageStore.getState().playback.currentTime).toBe(1);
    expect(useTriageStore.getState().playback.isPlaying).toBe(true);
  });

  it("setPlaying(true) in sequence keeps focus if already on a kept chunk", () => {
    seed([
      makeChunk({ id: "a", startMs: 1000, endMs: 2000 }),
      makeChunk({ id: "b", startMs: 5000, endMs: 6000 }),
    ]);
    useTriageStore.getState().setMode("sequence");
    useTriageStore.getState().focusChunk("b");
    useTriageStore.getState().setPlaying(true);
    expect(useTriageStore.getState().focusedChunkId).toBe("b");
  });

  it("setPlaying(true) in sequence with no kept chunks stays paused", () => {
    seed([makeChunk({ id: "a", startMs: 1000, endMs: 2000, accepted: false })]);
    useTriageStore.getState().setMode("sequence");
    useTriageStore.getState().setPlaying(true);
    expect(useTriageStore.getState().playback.isPlaying).toBe(false);
  });
});

describe("triage-store · seam preview", () => {
  beforeEach(() => useTriageStore.getState().reset());

  it("openSeam sets A, leaves B null, parks at loopIn, clears loop, pauses", () => {
    seed([makeChunk({ id: "a", startMs: 10000, endMs: 20000 })]);
    useTriageStore.getState().focusChunk("a");
    useTriageStore.getState().setPlaying(true);
    useTriageStore.getState().openSeam("a");
    const pb = useTriageStore.getState().playback;
    expect(pb.seam?.aId).toBe("a");
    expect(pb.seam?.bId).toBeNull();
    expect(pb.loop).toBeNull();
    expect(pb.isPlaying).toBe(false);
    // span = 2 bars @120 BPM = 4s → loopIn = 20 - 4 = 16
    expect(pb.seam?.loopInS).toBe(16);
    expect(pb.currentTime).toBe(16);
  });

  it("setSeamB sets B and a default loopOut bracket", () => {
    seed([
      makeChunk({ id: "a", startMs: 10000, endMs: 20000 }),
      makeChunk({ id: "b", startMs: 50000, endMs: 70000 }),
    ]);
    useTriageStore.getState().openSeam("a");
    useTriageStore.getState().setSeamB("b");
    const seam = useTriageStore.getState().playback.seam;
    expect(seam?.bId).toBe("b");
    // span 4s → loopOut = 50 + 4 = 54
    expect(seam?.loopOutS).toBe(54);
  });

  it("updateSeam merges bracket edits", () => {
    seed([
      makeChunk({ id: "a", startMs: 10000, endMs: 20000 }),
      makeChunk({ id: "b", startMs: 50000, endMs: 70000 }),
    ]);
    useTriageStore.getState().openSeam("a");
    useTriageStore.getState().setSeamB("b");
    useTriageStore.getState().updateSeam({ loopInS: 17, loopOutS: 55 });
    const seam = useTriageStore.getState().playback.seam;
    expect(seam?.loopInS).toBe(17);
    expect(seam?.loopOutS).toBe(55);
  });

  it("closeSeam clears seam and restores the mode's loop region", () => {
    seed([makeChunk({ id: "a", startMs: 2000, endMs: 6000 })]);
    useTriageStore.getState().focusChunk("a"); // loop mode default → loop armed
    useTriageStore.getState().openSeam("a");
    expect(useTriageStore.getState().playback.loop).toBeNull();
    useTriageStore.getState().closeSeam();
    const pb = useTriageStore.getState().playback;
    expect(pb.seam).toBeNull();
    expect(pb.loop).toEqual({ start: 2, end: 6 });
  });

  it("is orthogonal to mode — closing in continue restores no loop", () => {
    seed([makeChunk({ id: "a", startMs: 2000, endMs: 6000 })]);
    useTriageStore.getState().focusChunk("a");
    useTriageStore.getState().setMode("continue");
    useTriageStore.getState().openSeam("a");
    useTriageStore.getState().closeSeam();
    expect(useTriageStore.getState().playback.loop).toBeNull();
  });
});
