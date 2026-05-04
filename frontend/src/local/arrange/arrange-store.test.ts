/**
 * Arrange-Store unit tests.
 *
 * The store mirrors the chunk-as-card workflow: every accepted chunk in
 * the source-pool is independently insertable (and re-insertable) into
 * the linear arrangement. Re-insertions get a fresh ArrangementItem.id
 * so reorder/remove ops only touch one instance.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useArrangeStore } from "./arrange-store";
import type { ArrangementItem, Chunk, VideoAsset } from "../../storage/jobs-db";

function chunk(id: string, startMs: number, endMs: number, accepted = true): Chunk {
  return {
    id,
    startMs,
    endMs,
    bpmOctaveShift: 0,
    effectiveBpm: 120,
    detectedBpm: 120,
    beatsPerBar: 4,
    accepted,
    trimMode: "auto",
  };
}

function cam(id: string, color = "#FF5722"): VideoAsset {
  return {
    kind: "video",
    id,
    filename: `${id}.mp4`,
    opfsPath: `jobs/test/${id}.mp4`,
    color,
    durationS: 600,
    width: 1920,
    height: 1080,
    fps: 30,
  };
}

function arr(id: string, chunkId: string): ArrangementItem {
  return { id, chunkId };
}

describe("arrange-store · init", () => {
  beforeEach(() => useArrangeStore.getState().reset());

  it("seeds arrangement, focuses nothing, parks cursor at end", () => {
    const chunks = [chunk("c1", 0, 1000), chunk("c2", 2000, 3000)];
    const arrangement = [arr("a1", "c1"), arr("a2", "c2")];

    useArrangeStore.getState().initFromJob({
      jobId: "job-1",
      audioDuration: 60,
      chunks,
      arrangement,
      cams: [cam("cam-1")],
      jobBpm: 120,
      jobBeatsPerBar: 4,
    });

    const s = useArrangeStore.getState();
    expect(s.arrangement).toEqual(arrangement);
    expect(s.focusedItemId).toBeNull();
    expect(s.insertionIndex).toBe(2); // points at end
    expect(s.selectedCamId).toBe("cam-1");
  });
});

describe("arrange-store · insertion-cursor", () => {
  beforeEach(() => {
    useArrangeStore.getState().reset();
    useArrangeStore.getState().initFromJob({
      jobId: "j",
      audioDuration: 100,
      chunks: [chunk("c1", 0, 1000), chunk("c2", 2000, 3000), chunk("c3", 4000, 5000)],
      arrangement: [arr("a1", "c1"), arr("a2", "c2"), arr("a3", "c3")],
      cams: [],
      jobBpm: 120,
      jobBeatsPerBar: 4,
    });
  });

  it("setInsertionIndex clamps to [0, arrangement.length]", () => {
    const s = useArrangeStore.getState();
    s.setInsertionIndex(-5);
    expect(useArrangeStore.getState().insertionIndex).toBe(0);
    s.setInsertionIndex(99);
    expect(useArrangeStore.getState().insertionIndex).toBe(3);
    s.setInsertionIndex(2);
    expect(useArrangeStore.getState().insertionIndex).toBe(2);
  });

  it("nudgeCursor walks the strip", () => {
    const { setInsertionIndex, nudgeCursor } = useArrangeStore.getState();
    setInsertionIndex(0);
    nudgeCursor(1);
    expect(useArrangeStore.getState().insertionIndex).toBe(1);
    nudgeCursor(-1);
    expect(useArrangeStore.getState().insertionIndex).toBe(0);
    nudgeCursor(-1);
    expect(useArrangeStore.getState().insertionIndex).toBe(0); // clamps
    nudgeCursor(99);
    expect(useArrangeStore.getState().insertionIndex).toBe(3);
  });
});

describe("arrange-store · insertChunk", () => {
  beforeEach(() => {
    useArrangeStore.getState().reset();
    useArrangeStore.getState().initFromJob({
      jobId: "j",
      audioDuration: 100,
      chunks: [chunk("c1", 0, 1000), chunk("c2", 2000, 3000)],
      arrangement: [arr("a1", "c1")],
      cams: [],
      jobBpm: 120,
      jobBeatsPerBar: 4,
    });
  });

  it("inserts at cursor and advances cursor past the new item", () => {
    useArrangeStore.getState().setInsertionIndex(1); // end
    useArrangeStore.getState().insertChunkAtCursor("c2");
    const s = useArrangeStore.getState();
    expect(s.arrangement.map((a) => a.chunkId)).toEqual(["c1", "c2"]);
    expect(s.insertionIndex).toBe(2);
  });

  it("inserts in the middle without disturbing other items", () => {
    useArrangeStore.getState().setInsertionIndex(0); // start
    useArrangeStore.getState().insertChunkAtCursor("c2");
    const s = useArrangeStore.getState();
    expect(s.arrangement.map((a) => a.chunkId)).toEqual(["c2", "c1"]);
    expect(s.insertionIndex).toBe(1);
  });

  it("creates a fresh ArrangementItem.id each insertion (allows duplicates)", () => {
    const { insertChunkAtCursor } = useArrangeStore.getState();
    insertChunkAtCursor("c2");
    insertChunkAtCursor("c2");
    insertChunkAtCursor("c2");
    const ids = useArrangeStore.getState().arrangement.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects chunks not present in the chunks pool", () => {
    useArrangeStore.getState().insertChunkAtCursor("does-not-exist");
    const s = useArrangeStore.getState();
    expect(s.arrangement.map((a) => a.chunkId)).toEqual(["c1"]);
  });
});

describe("arrange-store · remove + reorder", () => {
  beforeEach(() => {
    useArrangeStore.getState().reset();
    useArrangeStore.getState().initFromJob({
      jobId: "j",
      audioDuration: 100,
      chunks: [chunk("c1", 0, 1000), chunk("c2", 2000, 3000), chunk("c3", 4000, 5000)],
      arrangement: [arr("a1", "c1"), arr("a2", "c2"), arr("a3", "c3")],
      cams: [],
      jobBpm: 120,
      jobBeatsPerBar: 4,
    });
  });

  it("removes by item id and clamps cursor", () => {
    const s = useArrangeStore.getState();
    s.setInsertionIndex(3);
    s.removeItem("a3");
    const after = useArrangeStore.getState();
    expect(after.arrangement.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(after.insertionIndex).toBe(2);
  });

  it("removes focused → clears focus", () => {
    const s = useArrangeStore.getState();
    s.focusItem("a2");
    s.removeItem("a2");
    expect(useArrangeStore.getState().focusedItemId).toBeNull();
  });

  it("shiftItem moves an item by delta clamping to bounds", () => {
    const s = useArrangeStore.getState();
    s.shiftItem("a3", -1);
    expect(useArrangeStore.getState().arrangement.map((a) => a.id)).toEqual([
      "a1",
      "a3",
      "a2",
    ]);
    s.shiftItem("a1", 99);
    expect(useArrangeStore.getState().arrangement.map((a) => a.id)).toEqual([
      "a3",
      "a2",
      "a1",
    ]);
  });

  it("reorderItem moves item to absolute index", () => {
    useArrangeStore.getState().reorderItem("a1", 2);
    expect(useArrangeStore.getState().arrangement.map((a) => a.id)).toEqual([
      "a2",
      "a3",
      "a1",
    ]);
  });

  it("duplicateItem inserts a copy directly after the source", () => {
    useArrangeStore.getState().duplicateItem("a2");
    const ids = useArrangeStore.getState().arrangement.map((a) => a.id);
    expect(ids[0]).toBe("a1");
    expect(ids[1]).toBe("a2");
    expect(ids[3]).toBe("a3");
    // a copy of a2 is at index 2 — chunkId equal, id different
    const copy = useArrangeStore.getState().arrangement[2];
    expect(copy.chunkId).toBe("c2");
    expect(copy.id).not.toBe("a2");
  });
});

describe("arrange-store · totals", () => {
  it("totalDurationMs sums chunk lengths in arrangement order", () => {
    useArrangeStore.getState().reset();
    useArrangeStore.getState().initFromJob({
      jobId: "j",
      audioDuration: 100,
      chunks: [chunk("c1", 0, 1000), chunk("c2", 2000, 5000)],
      arrangement: [arr("a1", "c1"), arr("a2", "c2"), arr("a3", "c1")],
      cams: [],
      jobBpm: 120,
      jobBeatsPerBar: 4,
    });
    const s = useArrangeStore.getState();
    // c1 = 1000ms; c2 = 3000ms; total = 1000 + 3000 + 1000 = 5000
    expect(s.totalDurationMs()).toBe(5000);
  });

  it("usageCounts buckets by chunkId", () => {
    useArrangeStore.getState().reset();
    useArrangeStore.getState().initFromJob({
      jobId: "j",
      audioDuration: 100,
      chunks: [chunk("c1", 0, 1000), chunk("c2", 2000, 3000)],
      arrangement: [arr("a1", "c1"), arr("a2", "c1"), arr("a3", "c2")],
      cams: [],
      jobBpm: 120,
      jobBeatsPerBar: 4,
    });
    const counts = useArrangeStore.getState().usageCounts();
    expect(counts["c1"]).toBe(2);
    expect(counts["c2"]).toBe(1);
  });
});
