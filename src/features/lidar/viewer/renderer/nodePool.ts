// ============================================
// GPU residency of streamed LOD nodes
// ============================================
//
// Each resident node owns its packed point buffer (12 B/point, uploaded
// as read from the LOD cache) and a pre-shaded colour buffer (4 B/point)
// written by the shading compute pass. Per-node parameters live in one
// uniform buffer, one 256-byte slot per node, bound with a dynamic offset.

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
  needsShading: boolean;
}

export class NodeGpuPool {
  private readonly device: GPUDevice;
  private readonly shadingLayout: GPUBindGroupLayout;
  private readonly uniformBuffer: GPUBuffer;
  readonly nodeBindGroup: GPUBindGroup;
  readonly capacity: number;
  private readonly freeSlots: number[] = [];
  private readonly gpu = new Map<number, NodeGpu>();
  private readonly record = new ArrayBuffer(NODE_UNIFORM_BYTES);
  private readonly recordF32 = new Float32Array(this.record);
  private readonly recordU32 = new Uint32Array(this.record);
  private shadeAll = true;
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
    this.shadeAll = true;
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
    this.recordF32[4] = 0;
    this.recordU32[5] = count;
    this.recordF32[6] = 0;
    this.recordF32[7] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, slot * NODE_UNIFORM_STRIDE, this.record);

    const shadingBindGroup = this.device.createBindGroup({
      layout: this.shadingLayout,
      entries: [
        { binding: 0, resource: { buffer: packed } },
        { binding: 1, resource: { buffer: shaded } },
        { binding: 2, resource: { buffer: this.uniformBuffer, offset: slot * NODE_UNIFORM_STRIDE, size: NODE_UNIFORM_BYTES } },
      ],
    });
    this.gpu.set(node.id, { packed, shaded, slot, count, shadingBindGroup, needsShading: true });
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

  /** Re-shades new nodes (or all of them after `invalidateShading`). */
  encodeShading(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, sceneBindGroup: GPUBindGroup): void {
    let pass: GPUComputePassEncoder | null = null;
    for (const entry of this.gpu.values()) {
      if (!this.shadeAll && !entry.needsShading) continue;
      if (!pass) {
        pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, sceneBindGroup);
      }
      pass.setBindGroup(1, entry.shadingBindGroup);
      pass.dispatchWorkgroups(Math.ceil(entry.count / POINT_SHADING_WORKGROUP_SIZE));
      entry.needsShading = false;
    }
    pass?.end();
    this.shadeAll = false;
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
  }
}
