// ============================================
// Terrain mesh LOD — WebGPU drawer
// ============================================
//
// Levels, stitching and push-back come from `TerrainLodSelector` (see
// terrainLodCore.ts). Here: the merged vertex buffers, every full-size index
// pattern packed in one buffer per grid width, and the push-back of each
// chunk in a storage buffer read by `terrain_lod_vs` through the instance
// index of the chunk's draw.

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
  /** Push-back (m) per chunk, indexed by the draw's instance index. */
  private readonly pushBackBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  /** Index patterns: key → range of a packed buffer. */
  private readonly patterns = new Map<string, IndexPattern>();
  private readonly ownedBuffers: GPUBuffer[] = [];
  /** Triangles drawn last frame (stats). */
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

  /** Every full-size pattern of a grid width in one index buffer, uploaded once. */
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

  /** Pattern of a chunk; partial chunks (grid edges not a multiple of the chunk size) get theirs on first use. */
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
   * Draws the visible chunks with `pipeline` (`terrain_lod_vs`; bind group 0
   * already set, group 1 = this.bindGroup); returns the draw count.
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
      // The instance index carries the chunk index (push-back lookup).
      pass.drawIndexed(pattern.count, 1, pattern.firstIndex, chunk.baseVertex, i);
      draws++;
      triangles += pattern.count / 3;
    }
    this.lastTriangles = triangles;
    return draws;
  }

  /**
   * Draws every chunk at the level whose quads are closest to `quadSizeM`
   * (photo mode's shadow maps and surface model: one fixed level, no
   * push-back, positions only in vertex buffer 0); returns the draw count.
   */
  drawFixedLevel(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, quadSizeM: number): number {
    const chunks = this.selector.chunks;
    if (chunks.length === 0) return 0;
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, this.vertexBuffer);
    let boundIndices: GPUBuffer | null = null;
    let draws = 0;
    for (const chunk of chunks) {
      const level = Math.max(0, Math.min(chunk.maxLevel, Math.round(Math.log2(Math.max(quadSizeM, 1e-3) / chunk.cell))));
      const pattern = this.pattern(chunk, level, 0);
      if (pattern.count === 0) continue;
      if (pattern.buffer !== boundIndices) {
        pass.setIndexBuffer(pattern.buffer, 'uint32');
        boundIndices = pattern.buffer;
      }
      pass.drawIndexed(pattern.count, 1, pattern.firstIndex, chunk.baseVertex, 0);
      draws++;
    }
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
