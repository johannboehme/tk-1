/**
 * Fullscreen-Quad-Geometry für alle FX-Shader.
 *
 * 2 Triangles, 4 Vertices, gl.TRIANGLE_STRIP. Coords sind Clip-space
 * (-1..1) — der Vertex-Shader mapped sie nach uv (0..1).
 */
export function makeFullscreenQuad(gl: WebGL2RenderingContext): {
  vao: WebGLVertexArrayObject;
  draw(): void;
  destroy(): void;
} {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("makeFullscreenQuad: createVertexArray failed");
  const vbo = gl.createBuffer();
  if (!vbo) {
    gl.deleteVertexArray(vao);
    throw new Error("makeFullscreenQuad: createBuffer failed");
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  // Vertex-shader expects a_position at attribute index 0.
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  return {
    vao,
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    destroy() {
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
    },
  };
}
