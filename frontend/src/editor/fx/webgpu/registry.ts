/**
 * Central registry of all WebGPU FX specs. Mirrors the WebGL2
 * `program-cache.ts` FRAGMENTS-Map: any new FX adds its spec here
 * (and a `drawWebGPU` method on its catalog entry) and is then auto-
 * available to the WebGPUBackend without further wiring.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";
import { ECHO_SPEC } from "./echo.wgsl";
import { RGB_SPEC } from "./rgb.wgsl";
import { TAPE_SPEC } from "./tape.wgsl";
import { UV_SPEC } from "./uv.wgsl";
import { VIGNETTE_SPEC } from "./vignette.wgsl";
import { WEAR_SPEC } from "./wear.wgsl";
import { ZOOM_SPEC } from "./zoom.wgsl";
import { GRADE_SPEC } from "./grade.wgsl";

export const FX_WEBGPU_SPECS: readonly FxWebGPUSpec[] = [
  VIGNETTE_SPEC,
  RGB_SPEC,
  ZOOM_SPEC,
  UV_SPEC,
  WEAR_SPEC,
  ECHO_SPEC,
  TAPE_SPEC,
  GRADE_SPEC,
];
