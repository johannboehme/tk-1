import { describe, expect, test } from "vitest";
import {
  SYNTHETIC_CHUNK_ID,
  SYNTHETIC_ITEM_ID,
  synthesizeJobLoadShape,
} from "./job-synth";
import type { LocalJob } from "../storage/jobs-db";

const baseJob: LocalJob = {
  id: "j1",
  title: null,
  videoFilename: "v.mp4",
  audioFilename: "a.mp3",
  createdAt: 0,
};

describe("synthesizeJobLoadShape", () => {
  test("single-take (no mode): synthesizes one segment spanning [0, duration]", () => {
    const shape = synthesizeJobLoadShape(baseJob, 60);
    expect(shape.arrangementSegments).toEqual([{ in: 0, out: 60 }]);
  });

  test("single-take: synthesizes one arrangement-item with stable __default__ id", () => {
    const shape = synthesizeJobLoadShape(baseJob, 60);
    expect(shape.arrangement).toEqual([
      { id: SYNTHETIC_ITEM_ID, chunkId: SYNTHETIC_CHUNK_ID },
    ]);
    expect(SYNTHETIC_ITEM_ID).toBe("__default__");
  });

  test("single-take: synthesizes one chunk covering the full master audio", () => {
    const shape = synthesizeJobLoadShape(baseJob, 60);
    expect(shape.chunks).toHaveLength(1);
    const c = shape.chunks[0];
    expect(c.id).toBe(SYNTHETIC_CHUNK_ID);
    expect(c.startMs).toBe(0);
    expect(c.endMs).toBe(60_000);
  });

  test("single-take: synthetic chunk omits audioStartMs (selectors fall back to meta)", () => {
    const shape = synthesizeJobLoadShape(baseJob, 60);
    expect(shape.chunks[0].audioStartMs).toBeUndefined();
  });

  test("explicit direct mode: same single-take synthesis", () => {
    const j: LocalJob = { ...baseJob, mode: "direct" };
    const shape = synthesizeJobLoadShape(j, 42);
    expect(shape.arrangementSegments).toEqual([{ in: 0, out: 42 }]);
    expect(shape.arrangement).toHaveLength(1);
    expect(shape.chunks).toHaveLength(1);
  });

  test("longform with arrangement: passes through arrangement+chunks", () => {
    const j: LocalJob = {
      ...baseJob,
      mode: "longform",
      arrangement: [
        { id: "a1", chunkId: "c1" },
        { id: "a2", chunkId: "c2" },
      ],
      chunks: [
        {
          id: "c1",
          startMs: 0,
          endMs: 5000,
          bpmOctaveShift: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
          accepted: true,
          trimMode: "free",
        },
        {
          id: "c2",
          startMs: 10_000,
          endMs: 20_000,
          bpmOctaveShift: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
          accepted: true,
          trimMode: "free",
        },
      ],
    };
    const shape = synthesizeJobLoadShape(j, 30);
    expect(shape.arrangement).toEqual(j.arrangement);
    expect(shape.chunks).toEqual(j.chunks);
    // arrangementToSegments converts ms→s
    expect(shape.arrangementSegments).toEqual([
      { in: 0, out: 5, chunkId: "c1" },
      { in: 10, out: 20, chunkId: "c2" },
    ]);
  });

  test("longform with empty arrangement: defensive fallback to single-take synthesis", () => {
    const j: LocalJob = {
      ...baseJob,
      mode: "longform",
      arrangement: [],
      chunks: [],
    };
    const shape = synthesizeJobLoadShape(j, 60);
    expect(shape.arrangementSegments).toEqual([{ in: 0, out: 60 }]);
    expect(shape.arrangement).toHaveLength(1);
  });

  test("longform with missing arrangement field: same defensive fallback", () => {
    const j: LocalJob = {
      ...baseJob,
      mode: "longform",
      // arrangement undefined
      chunks: [],
    };
    const shape = synthesizeJobLoadShape(j, 60);
    expect(shape.arrangementSegments).toEqual([{ in: 0, out: 60 }]);
  });

  test("zero/negative duration: synthesizes a degenerate but well-formed shape", () => {
    const shape = synthesizeJobLoadShape(baseJob, 0);
    expect(shape.arrangementSegments).toEqual([{ in: 0, out: 0 }]);
    expect(shape.arrangement).toHaveLength(1);
    expect(shape.chunks).toHaveLength(1);
    expect(shape.chunks[0].endMs).toBe(0);
  });

  test("pill-id stability: synthetic item id matches legacy DEFAULT_ITEM_ID sentinel", () => {
    // Pre-refactor, generateDefaultPills produced pill ids like
    // `${camId}::__default__`. With unification, generatePills runs through
    // the synthetic arrangement, and the resulting pill id is
    // `${camId}::${arrangement[0].id}`. They MUST be identical so persisted
    // pill edits on existing jobs survive the refactor.
    expect(SYNTHETIC_ITEM_ID).toBe("__default__");
  });
});
