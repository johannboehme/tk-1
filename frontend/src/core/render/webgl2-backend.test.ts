/**
 * Unit tests for the pure helpers in webgl2-backend. The WebGL2 context
 * is unavailable in jsdom, so the GL-touching paths live in the browser
 * test (`webgl2-backend.browser.test.ts`).
 *
 * The uv-matrix derivation:
 *   - Centred dest uv [-0.5, 0.5] in fitRect coords.
 *   - Centred source uv [-0.5, 0.5] in source coords.
 *   - Mapping: src = inverse(R(theta) * S(sx, sy)) * dest, then
 *     normalised to source's drawW/drawH (= fitRect dims swapped at 90°
 *     rotation). Matrix returned is column-major (GLSL mat2).
 */
import { describe, expect, it } from "vitest";
import { uvMatrixCM } from "./webgl2-backend";
import type { FrameLayer } from "./frame-descriptor";

function layer(over: Partial<FrameLayer> = {}): FrameLayer {
  return {
    layerId: "a",
    source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
    weight: 1,
    fitRect: { x: 0, y: 0, w: 100, h: 100 },
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    displayW: 100,
    displayH: 100,
    ...over,
  };
}

/** Apply column-major mat2 to a centred dest uv → centred source uv. */
function apply(m: Float32Array, dx: number, dy: number): [number, number] {
  // mat2(c0, c1) = [[m[0], m[2]], [m[1], m[3]]]; result = dx*c0 + dy*c1.
  return [m[0] * dx + m[2] * dy, m[1] * dx + m[3] * dy];
}

const TL = [-0.5, -0.5] as const;
const TR = [0.5, -0.5] as const;
const BL = [-0.5, 0.5] as const;
const BR = [0.5, 0.5] as const;

function near(a: [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

describe("uvMatrixCM — identity (rot=0, no flip)", () => {
  it("maps each dest corner to the same source corner", () => {
    const m = uvMatrixCM(layer());
    expect(near(apply(m, ...TL), TL)).toBe(true);
    expect(near(apply(m, ...TR), TR)).toBe(true);
    expect(near(apply(m, ...BL), BL)).toBe(true);
    expect(near(apply(m, ...BR), BR)).toBe(true);
  });
});

describe("uvMatrixCM — rotation only", () => {
  it("rot=90 maps dest TL → src BL (rotated 90° clockwise)", () => {
    const m = uvMatrixCM(layer({ rotationDeg: 90 }));
    expect(near(apply(m, ...TL), BL)).toBe(true);
    expect(near(apply(m, ...TR), TL)).toBe(true);
    expect(near(apply(m, ...BR), TR)).toBe(true);
    expect(near(apply(m, ...BL), BR)).toBe(true);
  });

  it("rot=180 maps each dest corner to the opposite corner", () => {
    const m = uvMatrixCM(layer({ rotationDeg: 180 }));
    expect(near(apply(m, ...TL), BR)).toBe(true);
    expect(near(apply(m, ...TR), BL)).toBe(true);
    expect(near(apply(m, ...BL), TR)).toBe(true);
    expect(near(apply(m, ...BR), TL)).toBe(true);
  });

  it("rot=270 maps dest TL → src TR (rotated 270° clockwise)", () => {
    const m = uvMatrixCM(layer({ rotationDeg: 270 }));
    expect(near(apply(m, ...TL), TR)).toBe(true);
    expect(near(apply(m, ...TR), BR)).toBe(true);
    expect(near(apply(m, ...BR), BL)).toBe(true);
    expect(near(apply(m, ...BL), TL)).toBe(true);
  });
});

describe("uvMatrixCM — flips", () => {
  it("flipX (no rotation) mirrors X axis", () => {
    const m = uvMatrixCM(layer({ flipX: true }));
    expect(near(apply(m, ...TL), TR)).toBe(true);
    expect(near(apply(m, ...BR), BL)).toBe(true);
  });

  it("flipY (no rotation) mirrors Y axis", () => {
    const m = uvMatrixCM(layer({ flipY: true }));
    expect(near(apply(m, ...TL), BL)).toBe(true);
    expect(near(apply(m, ...BR), TR)).toBe(true);
  });

  it("flipX + flipY (no rotation) inverts both axes", () => {
    const m = uvMatrixCM(layer({ flipX: true, flipY: true }));
    expect(near(apply(m, ...TL), BR)).toBe(true);
    expect(near(apply(m, ...TR), BL)).toBe(true);
  });
});

describe("uvMatrixCM — rotation + flip combinations", () => {
  // Verifies the post-rotation flip semantics — same convention as
  // compositor.ts (translate→rotate→scale→drawImage) and as the
  // Canvas2DBackend browser parity tests.
  it("rot=90 + flipX maps dest TL → src BR", () => {
    const m = uvMatrixCM(layer({ rotationDeg: 90, flipX: true }));
    expect(near(apply(m, ...TL), BR)).toBe(true);
  });

  it("rot=90 + flipY maps dest TL → src TL", () => {
    const m = uvMatrixCM(layer({ rotationDeg: 90, flipY: true }));
    expect(near(apply(m, ...TL), TL)).toBe(true);
  });

  it("rot=270 + flipX maps dest TL → src TL", () => {
    const m = uvMatrixCM(layer({ rotationDeg: 270, flipX: true }));
    expect(near(apply(m, ...TL), TL)).toBe(true);
  });
});

describe("uvMatrixCM — non-square fitRect at rot=90/270", () => {
  it("normalises swapped dims so corner mapping stays exact", () => {
    // fitRect 200×100 (wide), rotation 90 → drawW=100, drawH=200.
    const m = uvMatrixCM(layer({
      rotationDeg: 90,
      fitRect: { x: 0, y: 0, w: 200, h: 100 },
    }));
    // dest TL → src BL still
    expect(near(apply(m, ...TL), BL)).toBe(true);
    expect(near(apply(m, ...TR), TL)).toBe(true);
  });
});
