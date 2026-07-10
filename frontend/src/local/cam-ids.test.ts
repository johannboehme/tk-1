import { describe, expect, it } from "vitest";
import { nextCamIndex } from "./cam-ids";

const cams = (...ids: string[]) => ids.map((id) => ({ id }));

describe("nextCamIndex (#68)", () => {
  it("empty list → index 0 (first cam becomes cam-1)", () => {
    expect(nextCamIndex([])).toBe(0);
  });

  it("contiguous ids append at the end (same as the old length-based rule)", () => {
    expect(nextCamIndex(cams("cam-1", "cam-2", "cam-3"))).toBe(3); // → cam-4
  });

  it("delete-then-add never re-issues a live id", () => {
    // [cam-1, cam-2, cam-3] → delete cam-1 → [cam-2, cam-3]. The old
    // length-based allocation handed out index 2 → "cam-3", a duplicate
    // of the surviving cam-3: its lane got overwritten by the new file's
    // sync/trim, and the OPFS upload clobbered the old cam's media.
    expect(nextCamIndex(cams("cam-2", "cam-3"))).toBe(3); // → cam-4
  });

  it("survives deleting from the middle", () => {
    expect(nextCamIndex(cams("cam-1", "cam-3"))).toBe(3); // → cam-4
  });

  it("non-numeric ids fall back to the length floor", () => {
    expect(nextCamIndex(cams("weird", "cam-x"))).toBe(2); // → cam-3
    // Mixed: max parsed suffix wins over length when larger.
    expect(nextCamIndex(cams("weird", "cam-7"))).toBe(7); // → cam-8
  });
});
