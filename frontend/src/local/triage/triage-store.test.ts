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

  it("preserves left half audioStartMs, sets right half audioStartMs to split point", () => {
    seed([makeChunk({ id: "c1", startMs: 1000, endMs: 5000, audioStartMs: 1200 })]);
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
