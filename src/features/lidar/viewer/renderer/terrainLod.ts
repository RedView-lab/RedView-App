// ============================================
// LOD du maillage du terrain — dessin WebGPU
// ============================================
//
// Niveaux, couture et recul viennent de `TerrainLodSelector` (voir
// terrainLodCore.ts). Ici : les vertex buffers fusionnés, chaque motif
// d'indices pleine taille empaqueté dans un buffer par largeur de grille, et le
// recul de chaque chunk dans un storage buffer lu par `terrain_lod_vs` via
// l'indice d'instance du draw du chunk.

import {
  TerrainLodSelector,
  type TerrainChunk,
  type TerrainMeshData,
} from './terrainLodCore';

interface IndexPattern {
  buffer: GPUBuffer;
  firstIndex: number;
  count: number;
}

export class TerrainLod {
  private readonly device: GPUDevice;
  private readonly selector: TerrainLodSelector;
  private readonly vertexBuffer: GPUBuffer;
  private readonly colorBuffer: GPUBuffer;
  /** Recul (m) par chunk, indexé par l'indice d'instance du draw. */
  private readonly pushBackBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  /** Motifs d'indices : clé → plage d'un buffer empaqueté. */
  private readonly patterns = new Map<string, IndexPattern>();
  private readonly ownedBuffers: GPUBuffer[] = [];
  /** Triangles dessinés à la dernière image (statistiques). */
  lastTriangles = 0;

  constructor(device: GPUDevice, mesh: TerrainMeshData, bindGroupLayout: GPUBindGroupLayout) {
    this.device = device;
    this.selector = new TerrainLodSelector(mesh);
    this.vertexBuffer = device.createBuffer({ size: Math.max(4, mesh.vertices.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices as Float32Array<ArrayBuffer>);
    this.colorBuffer = device.createBuffer({ size: Math.max(4, mesh.colors.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.colorBuffer, 0, mesh.colors as Uint8Array<ArrayBuffer>);

    this.pushBackBuffer = device.createBuffer({
      size: this.selector.pushBack.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.pushBackBuffer } }],
    });
    this.uploadSharedPatterns();
  }

  /** Tous les motifs pleine taille d'une largeur de grille dans un seul index buffer, envoyé une fois. */
  private uploadSharedPatterns(): void {
    for (const lists of this.selector.sharedPatterns()) {
      const total = lists.reduce((sum, list) => sum + list.indices.length, 0);
      const packed = new Uint32Array(total);
      const buffer = this.device.createBuffer({ size: Math.max(4, packed.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      let offset = 0;
      for (const { key, indices } of lists) {
        packed.set(indices, offset);
        this.patterns.set(key, { buffer, firstIndex: offset, count: indices.length });
        offset += indices.length;
      }
      this.device.queue.writeBuffer(buffer, 0, packed);
      this.ownedBuffers.push(buffer);
    }
  }

  /** Motif d'un chunk ; les chunks partiels (bords de grille qui ne sont pas un multiple de la taille de chunk) reçoivent le leur au premier usage. */
  private pattern(chunk: TerrainChunk, level: number, stitch: number): IndexPattern {
    const key = TerrainLodSelector.chunkPatternKey(chunk, level, stitch);
    let pattern = this.patterns.get(key);
    if (!pattern) {
      const indices = TerrainLodSelector.chunkPatternIndices(chunk, level, stitch);
      const buffer = this.device.createBuffer({ size: Math.max(4, indices.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, indices);
      this.ownedBuffers.push(buffer);
      pattern = { buffer, firstIndex: 0, count: indices.length };
      this.patterns.set(key, pattern);
    }
    return pattern;
  }

  /**
   * Dessine les chunks visibles avec `pipeline` (`terrain_lod_vs` ; bind group 0
   * déjà posé, groupe 1 = this.bindGroup) ; renvoie le nombre de draws.
   */
  draw(
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    viewProj: Float32Array,
    camera: ArrayLike<number>,
    focalPx: number,
  ): number {
    const selector = this.selector;
    if (selector.chunks.length === 0) return 0;
    selector.select(viewProj, camera[0]!, camera[1]!, camera[2]!, focalPx);
    this.device.queue.writeBuffer(this.pushBackBuffer, 0, selector.pushBack);
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setVertexBuffer(1, this.colorBuffer);
    let boundIndices: GPUBuffer | null = null;
    let draws = 0;
    let triangles = 0;
    for (let i = 0; i < selector.chunks.length; i++) {
      if (!selector.visible[i]) continue;
      const chunk = selector.chunks[i]!;
      const pattern = this.pattern(chunk, selector.levels[i]!, selector.stitchOf(i));
      if (pattern.count === 0) continue;
      if (pattern.buffer !== boundIndices) {
        pass.setIndexBuffer(pattern.buffer, 'uint32');
        boundIndices = pattern.buffer;
      }
      // L'indice d'instance porte l'indice du chunk (recherche du recul).
      pass.drawIndexed(pattern.count, 1, pattern.firstIndex, chunk.baseVertex, i);
      draws++;
      triangles += pattern.count / 3;
    }
    this.lastTriangles = triangles;
    return draws;
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.colorBuffer.destroy();
    this.pushBackBuffer.destroy();
    for (const buffer of this.ownedBuffers) buffer.destroy();
    this.ownedBuffers.length = 0;
    this.patterns.clear();
  }
}
