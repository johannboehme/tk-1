/**
 * WGSL für den Layer-Pass des WebGPU-Backends.
 *
 * Spiegelt LAYER_VERT/LAYER_FRAG aus webgl2-backend.ts: positioniert
 * einen Quad anhand des Layer-`fitRect` (in Output-Pixel-Koords),
 * sampled die Source-Texture mit der `uvMatPacked`-Rotation/Flip-Matrix,
 * und blittet ins RenderTarget mit "over"-Blend (siehe Pipeline-Setup
 * in layer-blit.ts).
 *
 * Uniform-Struct-Layout (WGSL std140, total 48 bytes, alignment 16):
 *   offset  0 vec2f output       — backbuffer pixel dims
 *   offset  8 f32   srcFlipY     — 0 = uv as-is, 1 = mirror v
 *   offset 12 f32   _pad0
 *   offset 16 vec4f destRect     — x, y, w, h in output-pixel coords
 *   offset 32 vec4f uvMatPacked  — [m00, m10, m01, m11] column-major,
 *                                   identisch zu uvMatrixCM() in
 *                                   webgl2-backend.ts
 */
export const LAYER_BLIT_WGSL = `
struct LayerUniforms {
  output: vec2f,
  srcFlipY: f32,
  _pad0: f32,
  destRect: vec4f,
  uvMatPacked: vec4f,
};

@group(0) @binding(0) var u_samp: sampler;
@group(0) @binding(1) var u_tex:  texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: LayerUniforms;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  // 4-Vert Triangle-Strip; quadUv spannt 0..1 in beiden Achsen:
  // idx 0 = (0,0), 1 = (1,0), 2 = (0,1), 3 = (1,1).
  let quadUv = vec2f(f32(idx & 1u), f32((idx >> 1u) & 1u));

  // destPos in canvas-Y-down output-pixel coords.
  let destPos = u.destRect.xy + u.destRect.zw * quadUv;
  // → Clip-Space NDC (Y up).
  let clip = vec2f(
    destPos.x / u.output.x * 2.0 - 1.0,
    1.0 - destPos.y / u.output.y * 2.0
  );

  // uvMatPacked column-major: srcU = m00*x + m01*y, srcV = m10*x + m11*y
  let centred = quadUv - vec2f(0.5);
  let srcUV = vec2f(
    u.uvMatPacked.x * centred.x + u.uvMatPacked.z * centred.y,
    u.uvMatPacked.y * centred.x + u.uvMatPacked.w * centred.y
  ) + vec2f(0.5);

  var v: f32 = srcUV.y;
  if (u.srcFlipY > 0.5) {
    v = 1.0 - v;
  }

  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.uv = vec2f(srcUV.x, v);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSample(u_tex, u_samp, in.uv);
}
`;

/** Byte-Größe des LayerUniforms-Structs. Caller allokiert
 *  uniform-buffer mit dieser Größe. */
export const LAYER_UNIFORM_SIZE = 48;

/**
 * Packt die Layer-Uniforms in ein vorhandenes Float32Array (48 bytes /
 * 12 floats). Felder spiegeln das WGSL-Struct.
 *
 * `uvMatColMajor` muss das gleiche Format wie webgl2-backend.uvMatrixCM()
 * liefert: `[m00, m10, m01, m11]` column-major.
 */
export function writeLayerUniforms(
  out: Float32Array,
  outputW: number,
  outputH: number,
  destRect: { x: number; y: number; w: number; h: number },
  uvMatColMajor: ArrayLike<number>,
  srcFlipY: boolean,
): void {
  // offset 0: output (vec2f)
  out[0] = outputW;
  out[1] = outputH;
  // offset 8 (= float index 2): srcFlipY (f32)
  out[2] = srcFlipY ? 1 : 0;
  // offset 12 (= float index 3): _pad0
  out[3] = 0;
  // offset 16 (= float index 4..7): destRect (vec4f)
  out[4] = destRect.x;
  out[5] = destRect.y;
  out[6] = destRect.w;
  out[7] = destRect.h;
  // offset 32 (= float index 8..11): uvMatPacked (vec4f, column-major)
  out[8] = uvMatColMajor[0];
  out[9] = uvMatColMajor[1];
  out[10] = uvMatColMajor[2];
  out[11] = uvMatColMajor[3];
}
