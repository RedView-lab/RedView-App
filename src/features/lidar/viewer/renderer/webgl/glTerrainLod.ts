// ============================================
// LOD du maillage du terrain — dessin WebGL 2
// ============================================
//
// Niveaux, couture et recul viennent de `TerrainLodSelector` (voir
// ../terrainLodCore.ts), comme en WebGPU. WebGL 2 n'a pas de base vertex dans
// le cœur (l'extension draw-base-vertex est optionnelle) : chaque chunk déplace
// donc les pointeurs d'attributs sur son premier sommet ; les motifs d'indices
// lui sont relatifs dans les deux cas. Le recul est un uniform par chunk.

import {
  TERRAIN_VERTEX_FLOATS,
  TerrainLodSelector,
  type TerrainChunk,
  type TerrainMeshData,
} from '../terrainLodCore';
import { createStaticBuffer } from './glUtils';

const VERTEX_BYTES = TERRAIN_VERTEX_FLOATS * 4;

interface GlIndexPattern {
  buffer: WebGLBuffer;
  /** Décalage en octets dans `buffer`. */
  offset: number;
  count: number;
}

export class GlTerrainLod {
  private readonly gl: WebGL2RenderingContext;
  private readonly selector: TerrainLodSelector;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly colorBuffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly patterns = new Map<string, GlIndexPattern>();
  private readonly ownedBuffers: WebGLBuffer[] = [];
  /** Triangles dessinés à la dernière image (statistiques). */
  lastTriangles = 0;

  constructor(gl: WebGL2RenderingContext, mesh: TerrainMeshData) {
    this.gl = gl;
    this.selector = new TerrainLodSelector(mesh);
    this.vertexBuffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, mesh.vertices);
    this.colorBuffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, mesh.colors);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed (terrain)');
    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enableVertexAttribArray(2);
    this.attributesAt(0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.uploadSharedPatterns();
  }

  /** Pointeurs d'attributs commençant au sommet `base` (VAO du terrain lié). */
  private attributesAt(base: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, base * VERTEX_BYTES);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_BYTES, base * VERTEX_BYTES + 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 4, base * 4);
  }

  private uploadSharedPatterns(): void {
    for (const lists of this.selector.sharedPatterns()) {
      const total = lists.reduce((sum, list) => sum + list.indices.length, 0);
      const packed = new Uint32Array(Math.max(1, total));
      let offset = 0;
      const ranges: Array<{ key: string; offset: number; count: number }> = [];
      for (const { key, indices } of lists) {
        packed.set(indices, offset);
        ranges.push({ key, offset: offset * 4, count: indices.length });
        offset += indices.length;
      }
      const buffer = createStaticBuffer(this.gl, this.gl.ELEMENT_ARRAY_BUFFER, packed);
      this.ownedBuffers.push(buffer);
      for (const range of ranges) this.patterns.set(range.key, { buffer, offset: range.offset, count: range.count });
    }
  }

  private pattern(chunk: TerrainChunk, level: number, stitch: number): GlIndexPattern {
    const key = TerrainLodSelector.chunkPatternKey(chunk, level, stitch);
    let pattern = this.patterns.get(key);
    if (!pattern) {
      const indices = TerrainLodSelector.chunkPatternIndices(chunk, level, stitch);
      const buffer = createStaticBuffer(this.gl, this.gl.ELEMENT_ARRAY_BUFFER, indices.length > 0 ? indices : new Uint32Array(1));
      this.ownedBuffers.push(buffer);
      pattern = { buffer, offset: 0, count: indices.length };
      this.patterns.set(key, pattern);
    }
    return pattern;
  }

  /**
   * Dessine les chunks visibles avec le programme du terrain (courant, uniforms
   * de scène liés) ; `pushBackLocation` = son `u_pushBack`. Renvoie le nombre de draws.
   */
  draw(
    pushBackLocation: WebGLUniformLocation | null,
    viewProj: Float32Array,
    camera: ArrayLike<number>,
    focalPx: number,
  ): number {
    const gl = this.gl;
    const selector = this.selector;
    if (selector.chunks.length === 0) return 0;
    selector.select(viewProj, camera[0]!, camera[1]!, camera[2]!, focalPx);
    // Les motifs créés au premier usage lient l'element array hors du VAO.
    const patterns = new Array<GlIndexPattern | null>(selector.chunks.length);
    for (let i = 0; i < selector.chunks.length; i++) {
      patterns[i] = selector.visible[i] ? this.pattern(selector.chunks[i]!, selector.levels[i]!, selector.stitchOf(i)) : null;
    }
    gl.bindVertexArray(this.vao);
    let boundIndices: WebGLBuffer | null = null;
    let draws = 0;
    let triangles = 0;
    for (let i = 0; i < selector.chunks.length; i++) {
      const pattern = patterns[i];
      if (!pattern || pattern.count === 0) continue;
      if (pattern.buffer !== boundIndices) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pattern.buffer);
        boundIndices = pattern.buffer;
      }
      this.attributesAt(selector.chunks[i]!.baseVertex);
      gl.uniform1f(pushBackLocation, selector.pushBack[i]!);
      gl.drawElements(gl.TRIANGLES, pattern.count, gl.UNSIGNED_INT, pattern.offset);
      draws++;
      triangles += pattern.count / 3;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.lastTriangles = triangles;
    return draws;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.colorBuffer);
    for (const buffer of this.ownedBuffers) gl.deleteBuffer(buffer);
    this.ownedBuffers.length = 0;
    this.patterns.clear();
  }
}
