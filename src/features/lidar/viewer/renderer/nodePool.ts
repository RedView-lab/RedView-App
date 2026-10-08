// ============================================
// Résidence GPU des nœuds LOD chargés en flux
// ============================================
//
// Chaque nœud résident possède son buffer de points empaquetés (16 o/point,
// envoyé tel que lu dans le cache LOD) et un buffer de couleurs pré-ombrées
// (4 o/point) écrit par la passe de calcul d'ombrage. Les paramètres par nœud
// vivent dans un seul uniform buffer, un emplacement de 256 octets par nœud ;
// les masques d'enfants de chaque emplacement (taille de point adaptative,
// couleurs filtrées) vivent dans un seul storage buffer écrit une fois par image.
// L'ombrage est paresseux : un changement de mode de couleur, de surcouche ou
// d'éclairage ne fait qu'incrémenter une époque, et un nœud est ré-ombré la
// prochaine fois qu'il est dessiné : faire glisser un curseur coûte les points
// visibles, pas tout le pool. Un nœud est aussi ré-ombré quand ses enfants
// dessinés changent (ses points basculent entre leurs propres couleurs et
// celles filtrées par cellule).

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
  /** Époque d'ombrage pour laquelle les couleurs ont été écrites (−1 : jamais ombré). */
  shadedEpoch: number;
  /** Masque d'enfants pour lequel les couleurs ont été écrites. */
  shadedMask: number;
}

export class NodeGpuPool {
  private readonly device: GPUDevice;
  private readonly shadingLayout: GPUBindGroupLayout;
  private readonly uniformBuffer: GPUBuffer;
  readonly nodeBindGroup: GPUBindGroup;
  /** `childMasks[slot]`, lié dans le groupe 1 du pipeline des points. */
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
  private readonly shadowMasks: GPUBuffer[] = [];
  private shadowMaskData: Uint32Array<ArrayBuffer> | null = null;
  /** Erreurs de mémoire insuffisante signalées (de façon asynchrone) pour les envois de nœuds. */
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

  /** Chaque nœud doit être ré-ombré (changement de mode de couleur, de surcouche, d'éclairage ou de heightmap). */
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
   * Prépare les nœuds sur le point d'être dessinés : envoie les masques
   * d'enfants qui ont changé (une écriture pour la plage modifiée, mise en file
   * avant le submit de l'image, pour que l'ombrage de cette image les lise) et
   * encode l'ombrage de ceux dont les couleurs sont périmées (nouveaux nœuds,
   * tous les nœuds après `invalidateShading`, nœuds dont les enfants dessinés ont changé).
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

  /**
   * Par emplacement du pool, les octants qu'un nœud d'une sélection de
   * projeteurs d'ombre raffine (`SceneNode.shadowChildMask`), lus par les passes
   * d'ombre du mode photo : un buffer par carte d'ombre dessinée dans la même
   * image (`index`), créé au premier usage.
   */
  shadowMaskBuffer(index: number): GPUBuffer {
    let buffer = this.shadowMasks[index];
    if (!buffer) {
      buffer = this.device.createBuffer({
        size: this.capacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.shadowMasks[index] = buffer;
    }
    return buffer;
  }

  /** Envoie les masques d'ombre d'une sélection de projeteurs (buffer entier : les projeteurs couvrent le pool). */
  writeShadowMasks(index: number, nodes: readonly SceneNode[]): void {
    const buffer = this.shadowMaskBuffer(index);
    const masks = this.shadowMaskData ??= new Uint32Array(this.capacity);
    masks.fill(0);
    for (const node of nodes) {
      const entry = this.gpu.get(node.id);
      if (entry) masks[entry.slot] = node.shadowChildMask;
    }
    this.device.queue.writeBuffer(buffer, 0, masks);
  }

  /** Dessine les projeteurs dans une carte d'ombre (pipeline et groupe 0 posés ; groupe 1 = uniform du nœud) ; renvoie le nombre de draws. */
  drawShadow(pass: GPURenderPassEncoder, nodes: readonly SceneNode[]): number {
    let draws = 0;
    for (const node of nodes) {
      const entry = this.gpu.get(node.id);
      if (!entry) continue;
      pass.setBindGroup(1, this.nodeBindGroup, [entry.slot * NODE_UNIFORM_STRIDE]);
      pass.setVertexBuffer(0, entry.packed);
      pass.draw(4, entry.count);
      draws++;
    }
    return draws;
  }

  /** Dessine les nœuds donnés (pipeline et groupes 0/1 déjà posés) ; renvoie le nombre de draws. */
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
    for (const buffer of this.shadowMasks) buffer.destroy();
    this.shadowMasks.length = 0;
  }
}
