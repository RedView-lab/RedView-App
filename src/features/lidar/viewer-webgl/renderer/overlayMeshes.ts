/**
 * Maillages de surcouche du moteur terrain (aperçu de tuile, tracé) : buffers
 * GL créés au premier usage, remplis à chaque mise à jour, vidés en mettant le
 * nombre d'indices à 0 (les buffers sont gardés pour la mise à jour suivante).
 */

/** Aperçu de tuile : positions + normales entrelacées (6 flottants), couleurs RGBA8, indices uint32. */
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

    // sommets : pas de 6 flottants (pos : 3, normale : 3)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 6 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 3 * 4);

    // couleurs : pas de 4 octets (RGBA unorm)
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

/** Tracé : positions (vec3 float) et couleurs RGBA8 dans des buffers séparés, indices uint32. */
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

    // Positions (location 0 : vec3 float)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // Couleurs (location 1 : vec4 unsigned byte normalisé)
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
