import type { FlatOctree, PlatformProfile, VisibleNode } from './lod/types';
import {
  computePointChunkCapacity,
  destroyPointChunks,
  drawRange,
  MAX_BUFFER_POINTS,
  type PointChunkBuffers,
  uploadPointChunks,
} from './renderer/chunks';
import { mat4MultiplyInto } from './renderer/math';
import { choosePointShaderVariant, resolvePlatformInfo } from './renderer/platform';
import { TERRAIN_SHADER } from './renderer/shaders';
import type { HeightmapParams, SnowParams } from './renderer/types';

export type { HeightmapParams, SnowParams } from './renderer/types';

export class LidarRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private terrainPipeline!: GPURenderPipeline;
  private previewPipeline!: GPURenderPipeline;
  private cameraBuffer!: GPUBuffer;
  private pointBindGroup!: GPUBindGroup;
  private terrainBindGroup!: GPUBindGroup;
  private pointBindGroupLayout!: GPUBindGroupLayout;
  private terrainBindGroupLayout!: GPUBindGroupLayout;
  private depthTexture!: GPUTexture;
  private depthView!: GPUTextureView;
  private heightTexture!: GPUTexture;
  private heightSampler!: GPUSampler;
  private cameraBufferVoxel!: GPUBuffer;
  private pointBindGroupVoxel!: GPUBindGroup;
  private uniformCache = new Float32Array(52);
  private snowTexture!: GPUTexture;
  private snowMode: 0 | 1 | 2 = 0;
  private snowOriginX = 0;
  private snowOriginZ = 0;
  private snowScaleX = 1;
  private snowScaleZ = 1;
  private _tempFloat = new Float32Array(1);
  private _densityFloat = new Float32Array(1);
  /** Cached viewProj product to avoid re-multiplying when matrices are unchanged. */
  private _cachedViewProj = new Float32Array(16);
  private _lastView = new Float32Array(16);
  private _lastProj = new Float32Array(16);
  private _viewProjValid = false;

  private buffers: { pos: GPUBuffer; col: GPUBuffer; count: number }[] = [];
  private terrainMesh: { vertBuf: GPUBuffer; colBuf: GPUBuffer; idxBuf: GPUBuffer; count: number } | null = null;
  private previewMesh: { vertBuf: GPUBuffer; colBuf: GPUBuffer; idxBuf: GPUBuffer; count: number } | null = null;
  private canvasWidth = 1;
  private canvasHeight = 1;
  private hmOriginX = 0;
  private hmOriginZ = 0;
  private hmScaleX = 1;
  private hmScaleZ = 1;
  totalPoints = 0;
  pointSize = 0.59;
  lodThreshold = 500;
  terrainVisible = true;
  private pointChunkCapacity = MAX_BUFFER_POINTS;

  // Octree LOD buffers
  private leafChunks: PointChunkBuffers[] = [];
  private voxelChunks: PointChunkBuffers[] = [];
  lastViewProj: Float32Array = new Float32Array(16);
  lastCamPos: [number, number, number] = [0, 0, 0];
  lastCamFwd: [number, number, number] = [0, 0, -1];

  /** True when device is lost and not yet recovered. Guards render calls. */
  deviceLost = false;
  /** Platform profile detected at init (Apple vs Desktop). */
  platform: PlatformProfile | null = null;
  private gpuDrivenDensitySupported = false;
  private gpuDrivenDensityActive = false;
  private lastLeafBatchCount = 0;
  private lastVoxelBatchCount = 0;
  private lastDrawCallCount = 0;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU non supporté');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Pas de GPUAdapter');

    // --- Platform detection ---
    const { vendor, arch, desc, isApple, profile } = resolvePlatformInfo((adapter as any).info ?? null);
    this.platform = profile;
    this.gpuDrivenDensitySupported = !isApple;

    console.log(`[LiDAR GPU] Adapter: vendor=${vendor} arch=${arch} desc=${desc}`);
    console.log(`[LiDAR GPU] Platform profile: ${isApple ? 'Apple (Metal)' : 'Desktop'}`);

    // --- Feature detection ---
    const features: GPUFeatureName[] = [];
    const hasF32FilterSupport = adapter.features.has('float32-filterable');
    if (hasF32FilterSupport) features.push('float32-filterable');
    console.log(`[LiDAR GPU] float32-filterable: ${hasF32FilterSupport}`);

    // --- Device creation with error scope ---
    this.device = await adapter.requestDevice({ requiredFeatures: features });
    this.pointChunkCapacity = computePointChunkCapacity(this.device);

    console.log(`[LiDAR GPU] maxBufferSize: ${(this.device.limits.maxBufferSize / 1024 / 1024).toFixed(0)} MB`);
    console.log(`[LiDAR GPU] pointChunkCapacity: ${this.pointChunkCapacity.toLocaleString()}`);

    // --- Device lost handler ---
    this.device.lost.then((info) => {
      console.error(`[LiDAR GPU] Device lost: reason=${info.reason}, message=${info.message}`);
      this.deviceLost = true;
      if (info.reason !== 'destroyed') {
        // Surface recoverable loss to the user
        const statusEl = document.getElementById('status');
        const overlay = document.getElementById('overlay');
        if (statusEl) statusEl.textContent = `⚠️ GPU device lost: ${info.message || info.reason}. Rechargez la page.`;
        if (overlay) overlay.classList.remove('hidden');
      }
    });

    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    console.log(`[LiDAR GPU] Canvas format: ${this.format}`);

    const hasF32Filter = this.device.features.has('float32-filterable');

    // --- Bind group layouts ---
    // When float32-filterable is NOT available (Apple Metal), we use textureLoad
    // instead of textureGather. textureLoad doesn't use the sampler, but WebGPU
    // requires all bind group entries declared in the layout to be present.
    // We keep the sampler binding for layout compatibility but mark it non-filtering.
    this.pointBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: hasF32Filter ? 'float' : 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: hasF32Filter ? 'filtering' : 'non-filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    this.terrainBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    // --- Select shader variant based on platform & GPU features ---
    // Apple TBDR GPUs benefit massively from the lite shader (HSR re-enabled).
    // Other GPUs use the full quality shader (gather or load fallback).
    const { shaderCode, shaderLabel } = choosePointShaderVariant(isApple, hasF32Filter);
    console.log(`[LiDAR GPU] Shader variant: ${shaderLabel}`);

    // --- Pipeline creation with error scope to catch validation failures ---
    this.device.pushErrorScope('validation');

    const shader = this.device.createShaderModule({ code: shaderCode });
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.pointBindGroupLayout] }),
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }] },
          { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' as GPUVertexFormat }] },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    const terrainShader = this.device.createShaderModule({ code: TERRAIN_SHADER });
    this.terrainPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.terrainBindGroupLayout] }),
      vertex: {
        module: terrainShader,
        entryPoint: 'terrain_vs',
        buffers: [
          {
            arrayStride: 24,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
              { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
            ],
          },
          {
            arrayStride: 4,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'unorm8x4' as GPUVertexFormat },
            ],
          },
        ],
      },
      fragment: {
        module: terrainShader,
        entryPoint: 'terrain_fs',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    this.previewPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.terrainBindGroupLayout] }),
      vertex: {
        module: terrainShader,
        entryPoint: 'terrain_vs',
        buffers: [
          {
            arrayStride: 24,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
              { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
            ],
          },
          {
            arrayStride: 4,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'unorm8x4' as GPUVertexFormat },
            ],
          },
        ],
      },
      fragment: {
        module: terrainShader,
        entryPoint: 'terrain_fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    // Check for pipeline creation validation errors
    const pipelineError = await this.device.popErrorScope();
    if (pipelineError) {
      console.error(`[LiDAR GPU] Pipeline validation error: ${pipelineError.message}`);
      throw new Error(`GPU pipeline creation failed: ${pipelineError.message}`);
    }

    // Camera uniform: 208 bytes (52 × f32, 16-byte aligned) — includes snow params
    this.cameraBuffer = this.device.createBuffer({
      size: 208,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameraBufferVoxel = this.device.createBuffer({
      size: 208,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.heightTexture = this.device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.heightSampler = this.device.createSampler({
      magFilter: hasF32Filter ? 'linear' : 'nearest',
      minFilter: hasF32Filter ? 'linear' : 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Snow texture (1×1 placeholder — replaced via setSnow)
    this.snowTexture = this.device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.snowTexture },
      new Float32Array([0]) as Float32Array<ArrayBuffer>,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    this.rebuildBindGroups();
    this.resize(canvas.width, canvas.height);
  }

  getPointChunkCapacity(): number {
    return this.pointChunkCapacity;
  }

  getLastRenderStats(): { leafBatches: number; voxelBatches: number; drawCalls: number; gpuDrivenDensity: boolean } {
    return {
      leafBatches: this.lastLeafBatchCount,
      voxelBatches: this.lastVoxelBatchCount,
      drawCalls: this.lastDrawCallCount,
      gpuDrivenDensity: this.gpuDrivenDensityActive,
    };
  }

  private rebuildBindGroups() {
    this.pointBindGroup = this.device.createBindGroup({
      layout: this.pointBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 2, resource: this.heightSampler },
        { binding: 3, resource: this.snowTexture.createView() },
      ],
    });
    this.pointBindGroupVoxel = this.device.createBindGroup({
      layout: this.pointBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBufferVoxel } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 2, resource: this.heightSampler },
        { binding: 3, resource: this.snowTexture.createView() },
      ],
    });
    this.terrainBindGroup = this.device.createBindGroup({
      layout: this.terrainBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 3, resource: this.snowTexture.createView() },
      ],
    });
  }

  setHeightmap(params: HeightmapParams) {
    this.hmOriginX = params.originX;
    this.hmOriginZ = params.originZ;
    this.hmScaleX = params.scaleX;
    this.hmScaleZ = params.scaleZ;

    if (this.heightTexture) this.heightTexture.destroy();

    this.heightTexture = this.device.createTexture({
      size: [params.width, params.height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.writeTexture(
      { texture: this.heightTexture },
      params.data as Float32Array<ArrayBuffer>,
      { bytesPerRow: params.width * 4 },
      { width: params.width, height: params.height },
    );

    this.rebuildBindGroups();
  }

  /** Upload du champ de neige (cm) + paramètres de mapping monde→texture. */
  setSnow(params: SnowParams) {
    if (this.snowTexture) this.snowTexture.destroy();
    this.snowTexture = this.device.createTexture({
      size: [params.width, params.height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.snowTexture },
      params.data as Float32Array<ArrayBuffer>,
      { bytesPerRow: params.width * 4 },
      { width: params.width, height: params.height },
    );
    this.snowOriginX = params.originX;
    this.snowOriginZ = params.originZ;
    this.snowScaleX = params.scaleX;
    this.snowScaleZ = params.scaleZ;
    this.rebuildBindGroups();
  }

  /** 0 = off, 1 = couverture (blanc), 2 = épaisseur (heatmap). */
  setSnowMode(mode: 0 | 1 | 2) {
    this.snowMode = mode;
  }

  resize(w: number, h: number) {
    this.canvasWidth = w;
    this.canvasHeight = h;
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  setOctreeData(octree: FlatOctree): void {
    destroyPointChunks(this.leafChunks);
    destroyPointChunks(this.voxelChunks);
    this.leafChunks = [];
    this.voxelChunks = [];

    this.totalPoints = octree.totalLeafPoints;

    if (octree.leafPositions.byteLength > 0) {
      this.leafChunks = uploadPointChunks(this.device, this.pointChunkCapacity, octree.leafPositions, octree.leafColors);
    }

    if (octree.voxelPositions.byteLength > 0) {
      this.voxelChunks = uploadPointChunks(this.device, this.pointChunkCapacity, octree.voxelPositions, octree.voxelColors);
    }
  }

  renderLOD(visibleNodes: VisibleNode[], voxelPointSize?: number): void {
    if (!this.device || this.deviceLost) return;
    if (this.leafChunks.length === 0 && this.voxelChunks.length === 0 && !this.terrainMesh) return;

    const colorView = this.context.getCurrentTexture().createView();
    const effectiveVoxelSize = voxelPointSize ?? this.pointSize;
    this.lastLeafBatchCount = 0;
    this.lastVoxelBatchCount = 0;
    this.lastDrawCallCount = 0;

    if (effectiveVoxelSize !== this.pointSize) {
      this._tempFloat[0] = effectiveVoxelSize;
      this.device.queue.writeBuffer(this.cameraBufferVoxel, 28 * 4, this._tempFloat);
    }

    // Reset density to 1.0 for both camera buffers at start of frame
    this._densityFloat[0] = 1.0;
    this.device.queue.writeBuffer(this.cameraBuffer, 40 * 4, this._densityFloat);
    this.device.queue.writeBuffer(this.cameraBufferVoxel, 40 * 4, this._densityFloat);

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0.76, g: 0.87, b: 0.96, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.terrainMesh && this.terrainVisible) {
      pass.setPipeline(this.terrainPipeline);
      pass.setBindGroup(0, this.terrainBindGroup);
      pass.setVertexBuffer(0, this.terrainMesh.vertBuf);
      pass.setVertexBuffer(1, this.terrainMesh.colBuf);
      pass.setIndexBuffer(this.terrainMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.terrainMesh.count);
      this.lastDrawCallCount += 1;
    }

    if (this.previewMesh) {
      pass.setPipeline(this.previewPipeline);
      pass.setBindGroup(0, this.terrainBindGroup);
      pass.setVertexBuffer(0, this.previewMesh.vertBuf);
      pass.setVertexBuffer(1, this.previewMesh.colBuf);
      pass.setIndexBuffer(this.previewMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.previewMesh.count);
      this.lastDrawCallCount += 1;
    }

    pass.setPipeline(this.pipeline);

    if (this.voxelChunks.length > 0) {
      pass.setBindGroup(0, this.pointBindGroupVoxel);
      this.drawNodesBatched(pass, visibleNodes, this.voxelChunks, true, this.cameraBufferVoxel);
    }

    if (this.leafChunks.length > 0) {
      pass.setBindGroup(0, this.pointBindGroup);
      this.drawNodesBatched(pass, visibleNodes, this.leafChunks, false, this.cameraBuffer);
    }

    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Current density written to the uniform buffer (avoid redundant writes). */
  private currentDensityLeaf = 1.0;
  private currentDensityVoxel = 1.0;

  private shouldUseGpuDrivenDensity(nodes: VisibleNode[]): boolean {
    if (!this.gpuDrivenDensitySupported) return false;

    let visibleLeafNodes = 0;
    let thinnedLeafNodes = 0;
    let totalLeafDensity = 0;

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.isVoxel || node.count === 0) continue;
      visibleLeafNodes += 1;
      totalLeafDensity += node.density;
      if (node.density < 0.995) thinnedLeafNodes += 1;
    }

    if (visibleLeafNodes < 96 || thinnedLeafNodes < 24) return false;
    const avgLeafDensity = totalLeafDensity / Math.max(visibleLeafNodes, 1);
    return avgLeafDensity < 0.92;
  }

  private setGpuDrivenDensityActive(active: boolean): void {
    if (this.gpuDrivenDensityActive === active) return;
    this.gpuDrivenDensityActive = active;
    console.log(`[LiDAR GPU] Density path: ${active ? 'GPU-driven batching' : 'CPU-driven thinning'}`);
  }

  private drawNodesBatched(
    pass: GPURenderPassEncoder,
    nodes: VisibleNode[],
    chunks: PointChunkBuffers[],
    isVoxel: boolean,
    camBuffer: GPUBuffer,
  ): void {
    const useGpuDrivenDensity = !isVoxel && this.shouldUseGpuDrivenDensity(nodes);
    if (!isVoxel) this.setGpuDrivenDensityActive(useGpuDrivenDensity);

    const chunkState = { index: -1 };
    let batchStart = -1;
    let batchCount = 0;       // instances submitted to draw
    let batchSrcCount = 0;    // points consumed in source buffer (full count)
    let batchDensity = 1.0;
    let emittedBatches = 0;
    let emittedDrawCalls = 0;

    const flushBatch = () => {
      if (batchStart < 0) return;
      if (useGpuDrivenDensity) this.setDensityUniform(camBuffer, batchDensity, isVoxel);
      emittedDrawCalls += drawRange(pass, chunks, batchStart, batchCount, chunkState);
      emittedBatches += 1;
    };

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.isVoxel !== isVoxel || n.count === 0) continue;

      // CPU-side density: draw only the first `count*density` points of each
      // node. Leaf points were Fisher–Yates shuffled at build time so this
      // produces a spatially-uniform random subset without per-vertex hashing.
      // Voxels are already a coarse representation → never thinned (density=1).
      const d = isVoxel ? 1.0 : (n.density > 0.995 ? 1.0 : Math.round(n.density * 100) / 100);
      const drawCount = useGpuDrivenDensity || isVoxel
        ? n.count
        : Math.max(1, Math.ceil(n.count * d));

      const canBatch = useGpuDrivenDensity
        ? batchStart >= 0
          && n.offset === batchStart + batchSrcCount
          && Math.abs(d - batchDensity) < 0.005
        : batchStart >= 0
          && n.offset === batchStart + batchSrcCount
          && d === 1.0
          && batchDensity === 1.0;

      if (canBatch) {
        batchCount += drawCount;
        batchSrcCount += n.count;
      } else {
        flushBatch();
        batchStart = n.offset;
        batchCount = drawCount;
        batchSrcCount = n.count;
        batchDensity = d;
      }
    }
    flushBatch();

    this.lastDrawCallCount += emittedDrawCalls;
    if (isVoxel) {
      this.lastVoxelBatchCount = emittedBatches;
      return;
    }
    this.lastLeafBatchCount = emittedBatches;
  }

  private setDensityUniform(camBuffer: GPUBuffer, density: number, isVoxel: boolean): void {
    const current = isVoxel ? this.currentDensityVoxel : this.currentDensityLeaf;
    if (Math.abs(density - current) < 0.001) return;
    this._densityFloat[0] = density;
    this.device.queue.writeBuffer(camBuffer, 40 * 4, this._densityFloat);
    if (isVoxel) { this.currentDensityVoxel = density; }
    else { this.currentDensityLeaf = density; }
  }

  setPointCloud(positions: Float32Array, colors: Uint8Array) {
    for (const b of this.buffers) { b.pos.destroy(); b.col.destroy(); }
    this.buffers = [];
    this.totalPoints = positions.length / 3;

    let offset = 0;
    while (offset < this.totalPoints) {
      const count = Math.min(this.pointChunkCapacity, this.totalPoints - offset);

      const pos = this.device.createBuffer({ size: count * 12, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(pos, 0, positions as Float32Array<ArrayBuffer>, offset * 3, count * 3);

      const col = this.device.createBuffer({ size: count * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(col, 0, colors as Uint8Array<ArrayBuffer>, offset * 4, count * 4);

      this.buffers.push({ pos, col, count });
      offset += count;
    }
  }

  setMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    if (this.terrainMesh) {
      this.terrainMesh.vertBuf.destroy();
      this.terrainMesh.colBuf.destroy();
      this.terrainMesh.idxBuf.destroy();
    }

    const vertBuf = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(vertBuf.getMappedRange()).set(vertices);
    vertBuf.unmap();

    const colBuf = this.device.createBuffer({
      size: colors.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Uint8Array(colBuf.getMappedRange()).set(colors);
    colBuf.unmap();

    const idxBuf = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint32Array(idxBuf.getMappedRange()).set(indices);
    idxBuf.unmap();

    this.terrainMesh = { vertBuf, colBuf, idxBuf, count: indices.length };
  }

  setPreviewMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    this.clearPreviewMesh();

    const vertBuf = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(vertBuf.getMappedRange()).set(vertices);
    vertBuf.unmap();

    const colBuf = this.device.createBuffer({
      size: colors.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Uint8Array(colBuf.getMappedRange()).set(colors);
    colBuf.unmap();

    const idxBuf = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint32Array(idxBuf.getMappedRange()).set(indices);
    idxBuf.unmap();

    this.previewMesh = { vertBuf, colBuf, idxBuf, count: indices.length };
  }

  clearPreviewMesh(): void {
    if (!this.previewMesh) return;
    this.previewMesh.vertBuf.destroy();
    this.previewMesh.colBuf.destroy();
    this.previewMesh.idxBuf.destroy();
    this.previewMesh = null;
  }

  updateCamera(view: Float32Array, proj: Float32Array) {
    // Cache viewProj when view/proj are bit-identical to last call
    // (camera idle / paused). Avoids 64 muls + Float32Array(16) alloc per frame.
    let same = this._viewProjValid;
    if (same) {
      for (let i = 0; i < 16; i++) {
        if (this._lastView[i] !== view[i] || this._lastProj[i] !== proj[i]) { same = false; break; }
      }
    }
    let vp: Float32Array;
    if (same) {
      vp = this._cachedViewProj;
    } else {
      vp = mat4MultiplyInto(proj, view, this._cachedViewProj);
      this._lastView.set(view);
      this._lastProj.set(proj);
      this._viewProjValid = true;
    }

    const right = [view[0], view[4], view[8], 0];
    const up = [view[1], view[5], view[9], 0];

    const camX = -(view[0] * view[12] + view[1] * view[13] + view[2] * view[14]);
    const camY = -(view[4] * view[12] + view[5] * view[13] + view[6] * view[14]);
    const camZ = -(view[8] * view[12] + view[9] * view[13] + view[10] * view[14]);

    const sunDir = [0.4, 0.8, 0.45, 0];

    this.lastViewProj = vp;
    this.lastCamPos = [camX, camY, camZ];
    this.lastCamFwd = [-view[2], -view[6], -view[10]];

    const f = this.uniformCache;
    f.set(vp, 0);
    f[16] = right[0]; f[17] = right[1]; f[18] = right[2]; f[19] = right[3];
    f[20] = up[0]; f[21] = up[1]; f[22] = up[2]; f[23] = up[3];
    f[24] = camX; f[25] = camY; f[26] = camZ; f[27] = 1;
    f[28] = this.pointSize;
    f[29] = this.lodThreshold;
    f[30] = this.canvasWidth;
    f[31] = this.canvasHeight;
    f[32] = sunDir[0]; f[33] = sunDir[1]; f[34] = sunDir[2]; f[35] = sunDir[3];
    f[36] = this.hmOriginX;
    f[37] = this.hmOriginZ;
    f[38] = this.hmScaleX;
    f[39] = this.hmScaleZ;
    f[40] = 1.0; // density (default: keep all, updated per-node in drawNodesBatched)
    f[41] = 0;   // _pad1
    f[42] = 0;   // _pad2
    f[43] = 0;   // _pad3
    f[44] = this.snowMode;
    f[45] = this.snowOriginX;
    f[46] = this.snowOriginZ;
    f[47] = this.snowScaleX;
    f[48] = this.snowScaleZ;
    f[49] = 0;
    f[50] = 0;
    f[51] = 0;

    this.device.queue.writeBuffer(this.cameraBuffer, 0, f);
    this.device.queue.writeBuffer(this.cameraBufferVoxel, 0, f);
    this.currentDensityLeaf = 1.0;
    this.currentDensityVoxel = 1.0;
  }

  render() {
    if (!this.device || this.deviceLost || (this.buffers.length === 0 && !this.terrainMesh)) return;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.76, g: 0.87, b: 0.96, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.terrainMesh && this.terrainVisible) {
      pass.setPipeline(this.terrainPipeline);
      pass.setBindGroup(0, this.terrainBindGroup);
      pass.setVertexBuffer(0, this.terrainMesh.vertBuf);
      pass.setVertexBuffer(1, this.terrainMesh.colBuf);
      pass.setIndexBuffer(this.terrainMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.terrainMesh.count);
    }

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.pointBindGroup);

    for (const b of this.buffers) {
      pass.setVertexBuffer(0, b.pos);
      pass.setVertexBuffer(1, b.col);
      pass.draw(4, b.count);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy() {
    for (const b of this.buffers) { b.pos.destroy(); b.col.destroy(); }
    if (this.terrainMesh) {
      this.terrainMesh.vertBuf.destroy();
      this.terrainMesh.colBuf.destroy();
      this.terrainMesh.idxBuf.destroy();
    }
    this.clearPreviewMesh();
    destroyPointChunks(this.leafChunks);
    destroyPointChunks(this.voxelChunks);
    this.cameraBuffer?.destroy();
    this.cameraBufferVoxel?.destroy();
    this.depthTexture?.destroy();
    this.heightTexture?.destroy();
  }
}
