/**
 * Overlay meshes of the terrain engine (tile preview, route): GL buffers
 * created on first use, refilled on each update, cleared by setting the
 * index count to 0 (the buffers are kept for the next update).
 */

/** Tile preview: positions + normals interleaved (6 floats), RGBA8 colours, uint32 indices. */
export class GlPreviewMesh {
  vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private cbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  indexCount = 0;

  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  set(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    const gl = this.gl;
    if (indices.length === 0) {
      this.clear();
      return;
    }
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      this.vbo = gl.createBuffer();
      this.cbo = gl.createBuffer();
      this.ibo = gl.createBuffer();
    }
    gl.bindVertexArray(this.vao);

    // vertices: stride 6 floats (pos: 3, normal: 3)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 6 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 3 * 4);

    // colors: stride 4 bytes (RGBA unorm)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cbo);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // indices
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    this.indexCount = indices.length;
  }

  clear(): void {
    this.indexCount = 0;
  }

  destroy(): void {
    const gl = this.gl;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.cbo) gl.deleteBuffer(this.cbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}

/** Route: positions (vec3 float) and RGBA8 colours in separate buffers, uint32 indices. */
export class GlRouteMesh {
  vao: WebGLVertexArrayObject | null = null;
  private vboPos: WebGLBuffer | null = null;
  private vboCol: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  indexCount = 0;

  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  set(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    const gl = this.gl;
    if (indices.length === 0 || vertices.length === 0) {
      this.clear();
      return;
    }
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      this.vboPos = gl.createBuffer();
      this.vboCol = gl.createBuffer();
      this.ibo = gl.createBuffer();
    }
    gl.bindVertexArray(this.vao);

    // Positions (Location 0: vec3 float)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // Colors (Location 1: vec4 unsigned byte normalized)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // Indices
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    this.indexCount = count ?? indices.length;
  }

  clear(): void {
    this.indexCount = 0;
  }

  destroy(): void {
    const gl = this.gl;
    if (this.vboPos) gl.deleteBuffer(this.vboPos);
    if (this.vboCol) gl.deleteBuffer(this.vboCol);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}
