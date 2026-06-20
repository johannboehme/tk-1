import { describe, expect, it } from "vitest";
import { fxCatalog } from "./catalog";
import { REGISTERED_FRAGMENTS } from "./webgl2/program-cache";
import { FX_WEBGPU_SPECS } from "./webgpu/registry";
import { GRADE_SPEC } from "./webgpu/grade.wgsl";
import { ENGINE_DEFAULTS, GRADE_PARAM_KEYS } from "./looks";
import type { PunchFx } from "./types";
import type { WebGL2DrawContext, WebGPUDrawContext } from "./renderer-context";

/** Records every setUniform1f + the call sequence, ignoring the rest. */
function makeStub() {
  const uniforms: Record<string, number> = {};
  const calls: string[] = [];
  const base = {
    setUniform1f: (n: string, v: number) => {
      uniforms[n] = v;
    },
    setUniform1i: () => {},
    setUniform2f: () => {},
    setUniform4f: () => {},
    useProgram: (n: string) => calls.push(`useProgram:${n}`),
    bindSourceTexture: () => calls.push("bindSourceTexture"),
    setBlendMode: (m: string) => calls.push(`blend:${m}`),
    drawFullscreenQuad: () => calls.push("draw"),
  };
  return { uniforms, calls, ctx: base as unknown as WebGL2DrawContext & WebGPUDrawContext };
}

const fxFrom = (params: Record<string, number>): PunchFx => ({
  id: "g1",
  kind: "grade",
  inS: 0,
  outS: 0,
  params,
});

describe("GRADE — registration / wiring", () => {
  it("is registered across the catalog + both shader registries", () => {
    expect(fxCatalog.grade).toBeDefined();
    expect(fxCatalog.grade.kind).toBe("grade");
    expect(REGISTERED_FRAGMENTS).toContain("grade");
    expect(FX_WEBGPU_SPECS.map((s) => s.name)).toContain("grade");
  });

  it("WebGPU uniform fields match the canonical param order + time", () => {
    expect(GRADE_SPEC.uniformFields.map((f) => f.name)).toEqual([
      ...GRADE_PARAM_KEYS,
      "time",
    ]);
  });

  it("exposes no 2-knob params tuple (its surface is the Overlays panel)", () => {
    expect(fxCatalog.grade.params).toBeUndefined();
  });
});

describe("GRADE — backend parity (param level)", () => {
  it("WebGL2 (u_<key>) and WebGPU (<key>) drive identical uniform values", () => {
    const params = {
      ...ENGINE_DEFAULTS,
      exposure: 0.2,
      temp: 0.4,
      contrast: 0.3,
      saturation: 1.2,
      shadowsLift: 0.3,
      highlightsGain: 0.25,
    };
    const fx = fxFrom(params as unknown as Record<string, number>);
    const t = 7.5;

    const gl = makeStub();
    fxCatalog.grade.drawWebGL2(gl.ctx, fx, 1920, 1080, t);
    const gpu = makeStub();
    fxCatalog.grade.drawWebGPU(gpu.ctx, fx, 1920, 1080, t);

    for (const key of GRADE_PARAM_KEYS) {
      expect(gl.uniforms[`u_${key}`], `u_${key}`).toBe(params[key]);
      expect(gpu.uniforms[key], key).toBe(params[key]);
      expect(gl.uniforms[`u_${key}`], `parity ${key}`).toBe(gpu.uniforms[key]);
    }
    expect(gl.uniforms.u_time).toBe(t);
    expect(gpu.uniforms.time).toBe(t);
  });

  it("both backends bind source + use replace blend + draw once", () => {
    const fx = fxFrom({ ...ENGINE_DEFAULTS } as unknown as Record<string, number>);
    for (const draw of [
      (s: ReturnType<typeof makeStub>) => fxCatalog.grade.drawWebGL2(s.ctx, fx, 8, 8, 0),
      (s: ReturnType<typeof makeStub>) => fxCatalog.grade.drawWebGPU(s.ctx, fx, 8, 8, 0),
    ]) {
      const s = makeStub();
      draw(s);
      expect(s.calls).toContain("useProgram:grade");
      expect(s.calls).toContain("bindSourceTexture");
      expect(s.calls).toContain("blend:replace");
      expect(s.calls.filter((c) => c === "draw")).toHaveLength(1);
    }
  });

  it("skips the draw entirely at strength 0 (no wasted pass)", () => {
    const fx = fxFrom(
      { ...ENGINE_DEFAULTS, strength: 0 } as unknown as Record<string, number>,
    );
    const gl = makeStub();
    fxCatalog.grade.drawWebGL2(gl.ctx, fx, 8, 8, 0);
    const gpu = makeStub();
    fxCatalog.grade.drawWebGPU(gpu.ctx, fx, 8, 8, 0);
    expect(gl.calls).not.toContain("draw");
    expect(gpu.calls).not.toContain("draw");
  });
});
