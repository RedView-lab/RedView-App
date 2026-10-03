// ============================================
// GPU residency of streamed LOD nodes
// ============================================
//
// Each resident node owns its packed point buffer (16 B/point, uploaded
// as read from the LOD cache) and a pre-shaded colour buffer (4 B/point)
// written by the shading compute pass. Per-node parameters live in one
// uniform buffer, one 256-byte slot per node; the child masks of every slot
// (adaptive point size, filtered colours) live in one storage buffer written
// once per frame. Shading is lazy: a change of colour mode, overlay or
// lighting only bumps an epoch, and a node is re-shaded the next time it is
// drawn, so a slider drag costs the visible points, not the whole pool. A
// node is also re-shaded when its drawn children change (its points switch
// between their own and their cell-filtered colours).

import type { SceneNode } from '../lod/sceneLod';
import { LOD_POINT_STRIDE } from '../lod/lodTile';
import { NODE_UNIFORM_BYTES, POINT_SHADING_WORKGROUP_SIZE } from './shaders';

const NODE_UNIFORM_STRIDE = 256;

interface NodeGpu {
  packed: GPUBuffer;
  shaded: GPUBuffer;
  slot: number;
  count: number;
  shadingBindGroup: GPUBindGroup;
  /** Shading epoch the colours were written for (−1: never shaded). */
  shadedEpoch: number;
  /** Child mask the colours were written for. */
  shadedMask: number;
}

export class NodeGpuPool {
  private readonly device: GPUDevice;
  private readonly shadingLayout: GPUBindGroupLayout;
  private readonly uniformBuffer: GPUBuffer;
  readonly nodeBindGroup: GPUBindGroup;
  /** `childMasks[slot]`, bound in group 1 of the point pipeline. */
  readonly childMaskBuffer: GPUBuffer;
  private readonly childMasks: Uint32Array<ArrayBuffer>;
  private dirtyMaskMin = Infinity;
  private dirtyMaskMax = -1;
  readonly capacity: number;
  private readonly freeSlots: number[] = [];
  private readonly gpu = new Map<number, NodeGpu>();
  private readonly record = new ArrayBuffer(NODE_UNIFORM_BYTES);
  private readonly recordF32 = new Float32Array(this.record);
  private readonly recordU32 = new Uint32Array(this.record);
  private shadingEpoch = 0;
  /** Out-of-memory errors reported (asynchronously) for node uploads. */
  outOfMemoryCount = 0;

  constructor(device: GPUDevice, nodeLayout: GPUBindGroupLayout, shadingLayout: GPUBindGroupLayout, capacity: number) {
    this.device = device;
    this.shadingLayout = shadingLayout;
    this.capacity = capacity;
    this.uniformBuffer = device.createBuffer({
      size: capacity * NODE_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.nodeBindGroup = device.createBindGroup({
      layout: nodeLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, size: NODE_UNIFORM_BYTES } }],
    });
    this.childMasks = new Uint32Array(capacity);
    this.childMaskBuffer = device.createBuffer({
      size: capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    for (let slot = capacity - 1; slot >= 0; slot--) this.freeSlots.push(slot);
  }

  get residentNodes(): number {
    return this.gpu.size;
  }

  hasFreeSlot(): boolean {
    return this.freeSlots.length > 0;
  }

  /** Every node must be re-shaded (colour mode, overlay, lighting or heightmap change). */
  invalidateShading(): void {
    this.shadingEpoch++;
  }

  upload(node: SceneNode, block: ArrayBuffer): boolean {
    const count = node.entry.count;
    if (count === 0 || block.byteLength < count * LOD_POINT_STRIDE) return false;
    const slot = this.freeSlots.pop();
    if (slot === undefined) return false;

    this.device.pushErrorScope('out-of-memory');
    const packed = this.device.createBuffer({
      size: count * LOD_POINT_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const shaded = this.device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
    });
    void this.device.popErrorScope().then((error) => {
      if (error) {
        this.outOfMemoryCount++;
        console.warn('[LiDAR GPU] Out of memory while uploading a LOD node:', error.message);
      }
    });
    this.device.queue.writeBuffer(packed, 0, block, 0, count * LOD_POINT_STRIDE);

    this.recordF32[0] = node.originX;
    this.recordF32[1] = node.originY;
    this.recordF32[2] = node.originZ;
    this.recordF32[3] = node.size;
    this.recordF32[4] = node.adaptiveSpacing;
    this.recordU32[5] = count;
    this.recordU32[6] = slot;
    this.recordF32[7] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, slot * NODE_UNIFORM_STRIDE, this.record);
    this.setChildMask(slot, 0);

    const shadingBindGroup = this.device.createBindGroup({
      layout: this.shadingLayout,
      entries: [
        { binding: 0, resource: { buffer: packed } },
        { binding: 1, resource: { buffer: shaded } },
        { binding: 2, resource: { buffer: this.uniformBuffer, offset: slot * NODE_UNIFORM_STRIDE, size: NODE_UNIFORM_BYTES } },
        { binding: 3, resource: { buffer: this.childMaskBuffer } },
      ],
    });
    this.gpu.set(node.id, { packed, shaded, slot, count, shadingBindGroup, shadedEpoch: -1, shadedMask: 0 });
    return true;
  }

  release(node: SceneNode): void {
    const entry = this.gpu.get(node.id);
    if (!entry) return;
    entry.packed.destroy();
    entry.shaded.destroy();
    this.freeSlots.push(entry.slot);
    this.gpu.delete(node.id);
  }

  private setChildMask(slot: number, mask: number): void {
    if (this.childMasks[slot] === mask) return;
    this.childMasks[slot] = mask;
    if (slot < this.dirtyMaskMin) this.dirtyMaskMin = slot;
    if (slot > this.dirtyMaskMax) this.dirtyMaskMax = slot;
  }

  /**
   * Prepares the nodes about to be drawn: uploads the child masks that
   * changed (one write for the dirty range, queued before the frame's
   * submit, so this frame's shading reads them) and encodes the shading of
   * those whose colours are stale (new nodes, every node after
   * `invalidateShading`, nodes whose drawn children changed).
   */
  prepareFrame(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    sceneBindGroup: GPUBindGroup,
    nodes: readonly SceneNode[],
    timestampWrites?: () => GPUComputePassTimestampWrites | undefined,
  ): void {
    let pass: GPUComputePassEncoder | null = null;
    for (const node of nodes) {
      const entry = this.gpu.get(node.id);
      if (!entry) continue;
      this.setChildMask(entry.slot, node.childMask);
      if (entry.shadedEpoch === this.shadingEpoch && entry.shadedMask === node.childMask) continue;
      if (!pass) {
        pass = encoder.beginComputePass({ timestampWrites: timestampWrites?.() });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, sceneBindGroup);
      }
      pass.setBindGroup(1, entry.shadingBindGroup);
      pass.dispatchWorkgroups(Math.ceil(entry.count / POINT_SHADING_WORKGROUP_SIZE));
      entry.shadedEpoch = this.shadingEpoch;
      entry.shadedMask = node.childMask;
    }
    pass?.end();
    if (this.dirtyMaskMax >= this.dirtyMaskMin) {
      const first = this.dirtyMaskMin;
      const count = this.dirtyMaskMax - first + 1;
      this.device.queue.writeBuffer(this.childMaskBuffer, first * 4, this.childMasks, first, count);
      this.dirtyMaskMin = Infinity;
      this.dirtyMaskMax = -1;
    }
  }

  /** Draws the given nodes (pipeline and groups 0/1 already set); returns the draw count. */
  draw(pass: GPURenderPassEncoder, nodes: readonly SceneNode[]): number {
    let draws = 0;
    for (const node of nodes) {
      const entry = this.gpu.get(node.id);
      if (!entry) continue;
      pass.setBindGroup(2, this.nodeBindGroup, [entry.slot * NODE_UNIFORM_STRIDE]);
      pass.setVertexBuffer(0, entry.packed);
      pass.setVertexBuffer(1, entry.shaded);
      pass.draw(4, entry.count);
      draws++;
    }
    return draws;
  }

  destroy(): void {
    for (const entry of this.gpu.values()) {
      entry.packed.destroy();
      entry.shaded.destroy();
    }
    this.gpu.clear();
    this.uniformBuffer.destroy();
    this.childMaskBuffer.destroy();
  }
}
