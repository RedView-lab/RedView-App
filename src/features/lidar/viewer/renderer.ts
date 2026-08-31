import type { FlatOctree, PlatformProfile, VisibleNode } from './lod/types';
import {
  computePointChunkCapacity,
  destroyPointChunks,
  MAX_BUFFER_POINTS,
  type PointChunkBuffers,
  uploadPointChunks,
} from './renderer/chunks';
import { mat4MultiplyInto } from './renderer/math';
import { resolvePlatformInfo } from './renderer/platform';
import { createRendererPipelines } from './renderer/rendererPipeline';
import { drawNodesBatched } from './renderer/rendererBatchDrawer';
import type { HeightmapParams, SnowParams } from './renderer/types';
import { buildSlopeRampData } from './slope/slopeRamp';
import { buildAltitudeRampData, DEFAULT_MAX_ALTITUDE_M } from './altitude/altitudeRamp';
import type { ViewerSlopeState, ViewerAltitudeState } from './rightPanel/types';
import type { ViewerPointFilterState } from './pointFilter';
import { computePointFilterBitmasks } from './pointFilter';
import type { SolarRenderState } from '../viewer-webgl/sunlightController';

export type { HeightmapParams, SnowParams } from './renderer/types';
export type { ViewerSlopeState, ViewerAltitudeState, ViewerPointFilterState };

export class LidarRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private terrainPipeline!: GPURenderPipeline;
  private previewPipeline!: GPURenderPipeline;
  private trajectoryPipeline!: GPURenderPipeline;
  private sunDiscPipeline!: GPURenderPipeline;
  private routePipeline!: GPURenderPipeline;
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
  private uniformCache = new Float32Array(80);
  private uniformCacheU32 = new Uint32Array(this.uniformCache.buffer);

  private pointFilterEnabled = 0;
  private pointFilterMask: [number, number, number, number] = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];

  private trajectoryBuffer: GPUBuffer | null = null;
  private trajectoryVertexCount = 0;
  private trajectoryEnabled = false;
  private sunDiscPos: [number, number, number] | null = null;
  private sunDiscRadius = 0;

  private snowTexture!: GPUTexture;
  private snowMode: 0 | 1 | 2 = 0;
  private snowOriginX = 0;
  private snowOriginZ = 0;
  private snowScaleX = 1;
  private snowScaleZ = 1;

  private slopeTexture!: GPUTexture;
  private slopeSampler!: GPUSampler;
  private slopeEnabled = 0;
  private slopeOpacity = 0.5;
  private slopeFilter: 'linear' | 'nearest' = 'linear';

  private altitudeTexture!: GPUTexture;
  private altitudeSampler!: GPUSampler;
  private altitudeEnabled = 0;
  private altitudeOpacity = 0.5;
  private altitudeFilter: 'linear' | 'nearest' = 'linear';
  centerAltitude = 0;
  private maxAltitude = DEFAULT_MAX_ALTITUDE_M;

  private shadowTexture!: GPUTexture;
  private shadowEnabled = 0;
  private shadowOpacity = 0.5;

  private sunlightMapTexture!: GPUTexture;
  private sunlightEnabled = 0;
  private sunlightMapEnabled = 0;
  private sunlightMapOpacity = 0.5;
  private sunIntensity = 1.0;
  private exposure = 1.0;
  private sunDir: [number, number, number] = [0.28, 0.78, 0.55];
  private sunColor: [number, number, number] = [1.0, 0.98, 0.95];
  private skyColor: [number, number, number] = [0.65, 0.75, 0.85];

  private _tempFloat = new Float32Array(1);
  private _cachedViewProj = new Float32Array(16);
  private _lastView = new Float32Array(16);
  private _lastProj = new Float32Array(16);
  private _lastCamPosArr = new Float32Array(3);
  private _lastCamFwdArr = new Float32Array(3);

  private terrainMesh: { vertBuf: GPUBuffer; colBuf: GPUBuffer; idxBuf: GPUBuffer; count: number } | null = null;
  private previewMesh: { vertBuf: GPUBuffer; colBuf: GPUBuffer; idxBuf: GPUBuffer; count: number } | null = null;
  private routeMesh: { vertBuf: GPUBuffer; colBuf: GPUBuffer; idxBuf: GPUBuffer; count: number } | null = null;
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

  private leafChunks: PointChunkBuffers[] = [];
  private voxelChunks: PointChunkBuffers[] = [];
  lastViewProj: Float32Array = new Float32Array(16);
  lastCamPos: Float32Array | [number, number, number] = new Float32Array(3);
  lastCamFwd: Float32Array | [number, number, number] = new Float32Array([0, 0, -1]);

  deviceLost = false;
  platform: PlatformProfile | null = null;
  private gpuDrivenDensityActive = false;
  private lastLeafBatchCount = 0;
  private lastVoxelBatchCount = 0;
  private lastDrawCallCount = 0;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU non supporté');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Pas de GPUAdapter');

    const { vendor, arch, desc, isApple, profile } = resolvePlatformInfo((adapter as unknown as { info?: unknown }).info ?? null);
    this.platform = profile;

    console.log(`[LiDAR GPU] Adapter: vendor=${vendor} arch=${arch} desc=${desc}`);
    console.log(`[LiDAR GPU] Platform profile: ${isApple ? 'Apple (Metal)' : 'Desktop'}`);

    const features: GPUFeatureName[] = [];
    const hasF32FilterSupport = adapter.features.has('float32-filterable');
    if (hasF32FilterSupport) features.push('float32-filterable');

    this.device = await adapter.requestDevice({ requiredFeatures: features });
    this.pointChunkCapacity = computePointChunkCapacity(this.device);

    this.device.lost.then((info) => {
      console.error(`[LiDAR GPU] Device lost: reason=${info.reason}, message=${info.message}`);
      this.deviceLost = true;
      if (info.reason !== 'destroyed') {
        const statusEl = document.getElementById('status');
        const overlay = document.getElementById('overlay');
        if (statusEl) statusEl.textContent = `⚠️ GPU device lost: ${info.message || info.reason}. Rechargez la page.`;
        if (overlay) overlay.classList.remove('hidden');
      }
    });

    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    const hasF32Filter = this.device.features.has('float32-filterable');
    const pipelines = await createRendererPipelines(this.device, this.format, isApple, hasF32Filter);
    this.pipeline = pipelines.pointPipeline;
    this.terrainPipeline = pipelines.terrainPipeline;
    this.previewPipeline = pipelines.previewPipeline;
    this.trajectoryPipeline = pipelines.trajectoryPipeline;
    this.sunDiscPipeline = pipelines.sunDiscPipeline;
    this.routePipeline = pipelines.routePipeline;
    this.pointBindGroupLayout = pipelines.pointBindGroupLayout;
    this.terrainBindGroupLayout = pipelines.terrainBindGroupLayout;

    const bufferSize = 80 * 4; // 320 bytes
    this.cameraBuffer = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameraBufferVoxel = this.device.createBuffer({
      size: bufferSize,
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

    this.slopeTexture = this.device.createTexture({
      size: [256, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const initialSlopeRamp = new Uint8Array(256 * 4);
    this.device.queue.writeTexture(
      { texture: this.slopeTexture },
      initialSlopeRamp as Uint8Array<ArrayBuffer>,
      { bytesPerRow: 256 * 4 },
      { width: 256, height: 1 },
    );
    this.slopeSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.altitudeTexture = this.device.createTexture({
      size: [512, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const initialAltRamp = new Uint8Array(512 * 4);
    this.device.queue.writeTexture(
      { texture: this.altitudeTexture },
      initialAltRamp as Uint8Array<ArrayBuffer>,
      { bytesPerRow: 512 * 4 },
      { width: 512, height: 1 },
    );
    this.altitudeSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.shadowTexture = this.device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.shadowTexture },
      new Float32Array([0]) as Float32Array<ArrayBuffer>,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    this.sunlightMapTexture = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.sunlightMapTexture },
      new Uint8Array([0, 0, 0, 0]) as Uint8Array<ArrayBuffer>,
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
        { binding: 4, resource: this.slopeTexture.createView() },
        { binding: 5, resource: this.slopeSampler },
        { binding: 6, resource: this.altitudeTexture.createView() },
        { binding: 7, resource: this.altitudeSampler },
        { binding: 8, resource: this.shadowTexture.createView() },
        { binding: 9, resource: this.sunlightMapTexture.createView() },
      ],
    });

    this.pointBindGroupVoxel = this.device.createBindGroup({
      layout: this.pointBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBufferVoxel } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 2, resource: this.heightSampler },
        { binding: 3, resource: this.snowTexture.createView() },
        { binding: 4, resource: this.slopeTexture.createView() },
        { binding: 5, resource: this.slopeSampler },
        { binding: 6, resource: this.altitudeTexture.createView() },
        { binding: 7, resource: this.altitudeSampler },
        { binding: 8, resource: this.shadowTexture.createView() },
        { binding: 9, resource: this.sunlightMapTexture.createView() },
      ],
    });

    this.terrainBindGroup = this.device.createBindGroup({
      layout: this.terrainBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 3, resource: this.snowTexture.createView() },
        { binding: 4, resource: this.slopeTexture.createView() },
        { binding: 5, resource: this.slopeSampler },
        { binding: 6, resource: this.altitudeTexture.createView() },
        { binding: 7, resource: this.altitudeSampler },
        { binding: 8, resource: this.shadowTexture.createView() },
        { binding: 9, resource: this.sunlightMapTexture.createView() },
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

    const flipped = new Float32Array(params.data.length);
    const w = params.width;
    const h = params.height;
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w;
      const dstRow = y * w;
      for (let x = 0; x < w; x++) {
        flipped[dstRow + x] = params.data[srcRow + x]!;
      }
    }

    this.device.queue.writeTexture(
      { texture: this.heightTexture },
      flipped as Float32Array<ArrayBuffer>,
      { bytesPerRow: params.width * 4 },
      { width: params.width, height: params.height },
    );

    this.rebuildBindGroups();
  }

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

  setSnowMode(mode: 0 | 1 | 2) {
    this.snowMode = mode;
  }

  setSlopeState(state: ViewerSlopeState): void {
    if (!this.device || this.deviceLost) return;
    this.slopeEnabled = state.enabled ? 1 : 0;
    this.slopeOpacity = (state.opacity ?? 50) / 100;
    const isStepped = state.colorization === 'stepped';
    const desiredFilter: GPUFilterMode = isStepped ? 'nearest' : 'linear';

    if (state.bands && state.bands.length > 0) {
      const data = buildSlopeRampData(state.bands, state.colorization, 256);
      this.device.queue.writeTexture(
        { texture: this.slopeTexture },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: 256 * 4 },
        { width: 256, height: 1 },
      );
    }

    let needsRebind = false;
    if (this.slopeFilter !== desiredFilter) {
      this.slopeFilter = desiredFilter;
      this.slopeSampler = this.device.createSampler({
        magFilter: desiredFilter,
        minFilter: desiredFilter,
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      needsRebind = true;
    }

    if (needsRebind) {
      this.rebuildBindGroups();
    }

    this.uniformCache[49] = this.slopeEnabled;
    this.uniformCache[50] = this.slopeOpacity;

    if (this.cameraBuffer && this.cameraBufferVoxel) {
      this.device.queue.writeBuffer(this.cameraBuffer, 49 * 4, this.uniformCache.subarray(49, 51));
      this.device.queue.writeBuffer(this.cameraBufferVoxel, 49 * 4, this.uniformCache.subarray(49, 51));
    }
  }

  setAltitudeState(state: ViewerAltitudeState): void {
    if (!this.device || this.deviceLost) return;
    this.altitudeEnabled = state.enabled ? 1 : 0;
    this.altitudeOpacity = (state.opacity ?? 50) / 100;
    const isStepped = state.colorization === 'stepped';
    const desiredFilter: GPUFilterMode = isStepped ? 'nearest' : 'linear';

    if (state.bands && state.bands.length > 0) {
      const data = buildAltitudeRampData(state.bands, state.colorization, this.maxAltitude, 512);
      this.device.queue.writeTexture(
        { texture: this.altitudeTexture },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: 512 * 4 },
        { width: 512, height: 1 },
      );
    }

    let needsRebind = false;
    if (this.altitudeFilter !== desiredFilter) {
      this.altitudeFilter = desiredFilter;
      this.altitudeSampler = this.device.createSampler({
        magFilter: desiredFilter,
        minFilter: desiredFilter,
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      needsRebind = true;
    }

    if (needsRebind) {
      this.rebuildBindGroups();
    }

    this.uniformCache[51] = this.altitudeEnabled;
    this.uniformCache[52] = this.altitudeOpacity;

    if (this.cameraBuffer && this.cameraBufferVoxel) {
      this.device.queue.writeBuffer(this.cameraBuffer, 51 * 4, this.uniformCache.subarray(51, 53));
      this.device.queue.writeBuffer(this.cameraBufferVoxel, 51 * 4, this.uniformCache.subarray(51, 53));
    }
  }

  setMaxAltitude(maxAltitude: number): void {
    this.maxAltitude = maxAltitude;
  }

  setSunlightRenderState(renderState: SolarRenderState): void {
    if (!this.device || this.deviceLost) return;
    this.sunlightEnabled = renderState.enabled ? 1 : 0;
    this.sunDir = renderState.sunDir;
    this.sunColor = renderState.sunColor;
    this.sunIntensity = renderState.sunIntensity;
    this.skyColor = renderState.skyColor;
    this.exposure = renderState.exposure;
    this.shadowEnabled = renderState.shadowEnabled ? 1 : 0;
    this.shadowOpacity = renderState.shadowOpacity;
    this.sunlightMapEnabled = renderState.sunlightMapEnabled ? 1 : 0;
    this.sunlightMapOpacity = renderState.sunlightMapOpacity;

    let needsRebind = false;

    // Update shadow texture if provided
    if (renderState.shadowMapData && renderState.shadowMapWidth > 0 && renderState.shadowMapHeight > 0) {
      const sw = renderState.shadowMapWidth;
      const sh = renderState.shadowMapHeight;
      const f32Shadow = new Float32Array(sw * sh);
      for (let i = 0; i < sw * sh; i++) {
        f32Shadow[i] = renderState.shadowMapData[i]! / 255;
      }
      if (this.shadowTexture) this.shadowTexture.destroy();
      this.shadowTexture = this.device.createTexture({
        size: [sw, sh],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this.shadowTexture },
        f32Shadow as Float32Array<ArrayBuffer>,
        { bytesPerRow: sw * 4 },
        { width: sw, height: sh },
      );
      needsRebind = true;
    }

    // Update sunlight cumulative map texture if provided
    if (renderState.sunlightMapRgba && renderState.sunlightMapWidth > 0 && renderState.sunlightMapHeight > 0) {
      const mw = renderState.sunlightMapWidth;
      const mh = renderState.sunlightMapHeight;
      if (this.sunlightMapTexture) this.sunlightMapTexture.destroy();
      this.sunlightMapTexture = this.device.createTexture({
        size: [mw, mh],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this.sunlightMapTexture },
        renderState.sunlightMapRgba as Uint8Array<ArrayBuffer>,
        { bytesPerRow: mw * 4 },
        { width: mw, height: mh },
      );
      needsRebind = true;
    }

    if (needsRebind) {
      this.rebuildBindGroups();
    }

    // Sun direction
    const sunLen = Math.hypot(this.sunDir[0], this.sunDir[1], this.sunDir[2]) || 1;
    this.uniformCache[32] = this.sunDir[0] / sunLen;
    this.uniformCache[33] = this.sunDir[1] / sunLen;
    this.uniformCache[34] = this.sunDir[2] / sunLen;
    this.uniformCache[35] = 0;

    // Sunlight uniforms
    this.uniformCache[53] = this.sunlightEnabled;
    this.uniformCache[54] = this.shadowEnabled;
    this.uniformCache[55] = this.shadowOpacity;
    this.uniformCache[56] = this.sunlightMapEnabled;
    this.uniformCache[57] = this.sunlightMapOpacity;
    this.uniformCache[58] = this.sunIntensity;
    this.uniformCache[59] = this.exposure;

    // Sun color
    this.uniformCache[60] = this.sunColor[0];
    this.uniformCache[61] = this.sunColor[1];
    this.uniformCache[62] = this.sunColor[2];
    this.uniformCache[63] = 1.0;

    // Sky color
    this.uniformCache[64] = this.skyColor[0];
    this.uniformCache[65] = this.skyColor[1];
    this.uniformCache[66] = this.skyColor[2];
    this.uniformCache[67] = 1.0;

    this.trajectoryEnabled = renderState.trajectoryEnabled;
    this.sunDiscPos = renderState.sunDiscPos;
    this.sunDiscRadius = renderState.sunDiscRadius;

    if (renderState.trajectoryVertices && renderState.trajectoryVertexCount > 0) {
      if (this.trajectoryBuffer) {
        this.trajectoryBuffer.destroy();
      }
      this.trajectoryBuffer = this.device.createBuffer({
        size: renderState.trajectoryVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(
        this.trajectoryBuffer,
        0,
        renderState.trajectoryVertices as Float32Array<ArrayBuffer>,
      );
      this.trajectoryVertexCount = renderState.trajectoryVertexCount;
    } else {
      this.trajectoryVertexCount = 0;
    }

    if (this.sunDiscPos) {
      this.uniformCache[68] = this.sunDiscPos[0];
      this.uniformCache[69] = this.sunDiscPos[1];
      this.uniformCache[70] = this.sunDiscPos[2];
      this.uniformCache[71] = this.sunDiscRadius;
    } else {
      this.uniformCache[68] = 0;
      this.uniformCache[69] = 0;
      this.uniformCache[70] = 0;
      this.uniformCache[71] = 0;
    }

    if (this.cameraBuffer && this.cameraBufferVoxel) {
      this.device.queue.writeBuffer(this.cameraBuffer, 32 * 4, this.uniformCache.subarray(32, 36));
      this.device.queue.writeBuffer(this.cameraBuffer, 53 * 4, this.uniformCache.subarray(53, 72));
      this.device.queue.writeBuffer(this.cameraBufferVoxel, 32 * 4, this.uniformCache.subarray(32, 36));
      this.device.queue.writeBuffer(this.cameraBufferVoxel, 53 * 4, this.uniformCache.subarray(53, 72));
    }
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

  uploadPointCloud(tree: FlatOctree): void {
    destroyPointChunks(this.leafChunks);
    destroyPointChunks(this.voxelChunks);
    this.totalPoints = tree.totalLeafPoints;
    this.leafChunks = uploadPointChunks(this.device, this.pointChunkCapacity, tree.leafPositions, tree.leafColors);
    this.voxelChunks = uploadPointChunks(this.device, this.pointChunkCapacity, tree.voxelPositions, tree.voxelColors);
  }

  setOctreeData(tree: FlatOctree): void {
    this.uploadPointCloud(tree);
  }

  setMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    this.setTerrainMesh({
      vertices,
      colors,
      indices,
      count: count ?? indices.length,
    });
  }

  setTerrainMesh(mesh: { vertices: Float32Array; colors: Uint8Array; indices: Uint32Array; count: number }) {
    if (this.terrainMesh) {
      this.terrainMesh.vertBuf.destroy();
      this.terrainMesh.colBuf.destroy();
      this.terrainMesh.idxBuf.destroy();
    }
    const vertBuf = this.device.createBuffer({
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertBuf, 0, mesh.vertices as Float32Array<ArrayBuffer>);

    const colBuf = this.device.createBuffer({
      size: mesh.colors.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(colBuf, 0, mesh.colors as Uint8Array<ArrayBuffer>);

    const idxBuf = this.device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(idxBuf, 0, mesh.indices as Uint32Array<ArrayBuffer>);

    this.terrainMesh = { vertBuf, colBuf, idxBuf, count: mesh.count };
  }

  setPreviewMesh(
    meshOrVertices: { vertices: Float32Array; colors: Uint8Array; indices: Uint32Array; count: number } | Float32Array,
    colors?: Uint8Array,
    indices?: Uint32Array,
  ) {
    if (meshOrVertices instanceof Float32Array) {
      if (!colors || !indices) return;
      this.clearPreviewMesh();
      const vertBuf = this.device.createBuffer({
        size: meshOrVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vertBuf, 0, meshOrVertices as Float32Array<ArrayBuffer>);

      const colBuf = this.device.createBuffer({
        size: colors.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(colBuf, 0, colors as Uint8Array<ArrayBuffer>);

      const idxBuf = this.device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(idxBuf, 0, indices as Uint32Array<ArrayBuffer>);

      this.previewMesh = { vertBuf, colBuf, idxBuf, count: indices.length };
      return;
    }

    this.clearPreviewMesh();
    const vertBuf = this.device.createBuffer({
      size: meshOrVertices.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertBuf, 0, meshOrVertices.vertices as Float32Array<ArrayBuffer>);

    const colBuf = this.device.createBuffer({
      size: meshOrVertices.colors.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(colBuf, 0, meshOrVertices.colors as Uint8Array<ArrayBuffer>);

    const idxBuf = this.device.createBuffer({
      size: meshOrVertices.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(idxBuf, 0, meshOrVertices.indices as Uint32Array<ArrayBuffer>);

    this.previewMesh = { vertBuf, colBuf, idxBuf, count: meshOrVertices.count };
  }

  clearPreviewMesh(): void {
    if (this.previewMesh) {
      this.previewMesh.vertBuf.destroy();
      this.previewMesh.colBuf.destroy();
      this.previewMesh.idxBuf.destroy();
      this.previewMesh = null;
    }
  }

  setRouteMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    this.clearRouteMesh();
    if (!this.device || vertices.length === 0 || indices.length === 0) return;

    const vertBuf = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertBuf, 0, vertices as Float32Array<ArrayBuffer>);

    const colBuf = this.device.createBuffer({
      size: colors.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(colBuf, 0, colors as Uint8Array<ArrayBuffer>);

    const idxBuf = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(idxBuf, 0, indices as Uint32Array<ArrayBuffer>);

    this.routeMesh = { vertBuf, colBuf, idxBuf, count: count ?? indices.length };
  }

  setPointFilterState(state: ViewerPointFilterState): void {
    this.pointFilterEnabled = state.enabled ? 1.0 : 0.0;
    this.pointFilterMask = computePointFilterBitmasks(state.enabled, state.categories);
  }

  clearRouteMesh(): void {
    if (this.routeMesh) {
      this.routeMesh.vertBuf.destroy();
      this.routeMesh.colBuf.destroy();
      this.routeMesh.idxBuf.destroy();
      this.routeMesh = null;
    }
  }

  updateCamera(
    viewMat: Float32Array | number[],
    projMat: Float32Array | number[],
    camPos?: [number, number, number] | Float32Array,
    camFwd?: [number, number, number] | Float32Array,
    density = 1.0,
  ) {
    if (!this.device || this.deviceLost) return;

    const vArr = this._lastView;
    const pArr = this._lastProj;
    for (let i = 0; i < 16; i++) {
      vArr[i] = viewMat[i]!;
      pArr[i] = projMat[i]!;
    }

    let cpx = 0, cpy = 0, cpz = 0;
    if (camPos && camPos.length >= 3) {
      cpx = camPos[0]!; cpy = camPos[1]!; cpz = camPos[2]!;
    } else {
      cpx = -(vArr[0]! * vArr[12]! + vArr[1]! * vArr[13]! + vArr[2]! * vArr[14]!);
      cpy = -(vArr[4]! * vArr[12]! + vArr[5]! * vArr[13]! + vArr[6]! * vArr[14]!);
      cpz = -(vArr[8]! * vArr[12]! + vArr[9]! * vArr[13]! + vArr[10]! * vArr[14]!);
    }

    let cfx = 0, cfy = 0, cfz = -1;
    if (camFwd && camFwd.length >= 3) {
      cfx = camFwd[0]!; cfy = camFwd[1]!; cfz = camFwd[2]!;
    } else {
      cfx = -vArr[8]!; cfy = -vArr[9]!; cfz = -vArr[10]!;
    }

    this.lastCamPos = [cpx, cpy, cpz];
    this.lastCamFwd = [cfx, cfy, cfz];
    const posArr = this._lastCamPosArr;
    posArr[0] = cpx; posArr[1] = cpy; posArr[2] = cpz;
    const fwdArr = this._lastCamFwdArr;
    fwdArr[0] = cfx; fwdArr[1] = cfy; fwdArr[2] = cfz;

    const f = this.uniformCache;

    // 0..15: viewProj
    mat4MultiplyInto(this._cachedViewProj, pArr, vArr);
    for (let i = 0; i < 16; i++) {
      f[i] = this._cachedViewProj[i]!;
    }
    this.lastViewProj.set(this._cachedViewProj);

    // 16..19: right
    f[16] = viewMat[0]!;
    f[17] = viewMat[4]!;
    f[18] = viewMat[8]!;
    f[19] = 0;

    // 20..23: up
    f[20] = viewMat[1]!;
    f[21] = viewMat[5]!;
    f[22] = viewMat[9]!;
    f[23] = 0;

    // 24..27: cameraPos
    f[24] = cpx;
    f[25] = cpy;
    f[26] = cpz;
    f[27] = 1;

    // 28..31: scalars
    f[28] = this.pointSize;
    f[29] = this.lodThreshold;
    f[30] = this.canvasWidth;
    f[31] = this.canvasHeight;

    // 32..35: sunDir
    const sunLen = Math.hypot(this.sunDir[0], this.sunDir[1], this.sunDir[2]) || 1;
    f[32] = this.sunDir[0] / sunLen;
    f[33] = this.sunDir[1] / sunLen;
    f[34] = this.sunDir[2] / sunLen;
    f[35] = 0;

    // 36..39: heightmap params
    f[36] = this.hmOriginX;
    f[37] = this.hmOriginZ;
    f[38] = this.hmScaleX;
    f[39] = this.hmScaleZ;

    // 40..43: density & altitude params
    f[40] = density;
    f[41] = this.centerAltitude;
    f[42] = this.maxAltitude;
    f[43] = 0;

    // 44..48: snow params
    f[44] = this.snowMode;
    f[45] = this.snowOriginX;
    f[46] = this.snowOriginZ;
    f[47] = this.snowScaleX;
    f[48] = this.snowScaleZ;

    // 49..52: slope and altitude state
    f[49] = this.slopeEnabled;
    f[50] = this.slopeOpacity;
    f[51] = this.altitudeEnabled;
    f[52] = this.altitudeOpacity;

    // 53..59: sunlight params
    f[53] = this.sunlightEnabled;
    f[54] = this.shadowEnabled;
    f[55] = this.shadowOpacity;
    f[56] = this.sunlightMapEnabled;
    f[57] = this.sunlightMapOpacity;
    f[58] = this.sunIntensity;
    f[59] = this.exposure;

    // 60..63: sun color
    f[60] = this.sunColor[0];
    f[61] = this.sunColor[1];
    f[62] = this.sunColor[2];
    f[63] = 1.0;

    // 64..67: sky color
    f[64] = this.skyColor[0];
    f[65] = this.skyColor[1];
    f[66] = this.skyColor[2];
    f[67] = 1.0;

    // 68..71: sun disc
    if (this.sunDiscPos) {
      f[68] = this.sunDiscPos[0];
      f[69] = this.sunDiscPos[1];
      f[70] = this.sunDiscPos[2];
      f[71] = this.sunDiscRadius;
    } else {
      f[68] = 0;
      f[69] = 0;
      f[70] = 0;
      f[71] = 0;
    }

    // 72..75: point filter params
    f[72] = this.pointFilterEnabled;
    f[73] = 0;
    f[74] = 0;
    f[75] = 0;

    // 76..79: point filter bitmask (u32 words)
    this.uniformCacheU32[76] = this.pointFilterMask[0] >>> 0;
    this.uniformCacheU32[77] = this.pointFilterMask[1] >>> 0;
    this.uniformCacheU32[78] = this.pointFilterMask[2] >>> 0;
    this.uniformCacheU32[79] = this.pointFilterMask[3] >>> 0;

    const q = this.device.queue;
    q.writeBuffer(this.cameraBuffer, 0, f as Float32Array<ArrayBuffer>);
    q.writeBuffer(this.cameraBufferVoxel, 0, f as Float32Array<ArrayBuffer>);
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

    const clearR = this.sunlightEnabled ? this.skyColor[0] : 0.76;
    const clearG = this.sunlightEnabled ? this.skyColor[1] : 0.87;
    const clearB = this.sunlightEnabled ? this.skyColor[2] : 0.96;

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1 },
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
      const voxelStats = drawNodesBatched(pass, visibleNodes, this.voxelChunks, true, this.pointChunkCapacity);
      this.lastVoxelBatchCount = voxelStats.batches;
      this.lastDrawCallCount += voxelStats.drawCalls;
    }

    if (this.leafChunks.length > 0) {
      pass.setBindGroup(0, this.pointBindGroup);
      const leafStats = drawNodesBatched(pass, visibleNodes, this.leafChunks, false, this.pointChunkCapacity);
      this.lastLeafBatchCount = leafStats.batches;
      this.lastDrawCallCount += leafStats.drawCalls;
    }

    // Draw 3D Sun Trajectory Arc (if active)
    if (this.trajectoryEnabled && this.trajectoryVertexCount > 1 && this.trajectoryBuffer) {
      pass.setPipeline(this.trajectoryPipeline);
      pass.setBindGroup(0, this.pointBindGroup);
      pass.setVertexBuffer(0, this.trajectoryBuffer);
      pass.draw(this.trajectoryVertexCount, 1, 0, 0);
      this.lastDrawCallCount += 1;
    }

    // Draw 3D Celestial Sun Disc Billboard (if active)
    if (this.trajectoryEnabled && this.sunDiscPos) {
      pass.setPipeline(this.sunDiscPipeline);
      pass.setBindGroup(0, this.pointBindGroup);
      pass.draw(6, 1, 0, 0);
      this.lastDrawCallCount += 1;
    }

    // Draw 3D GPX Route Overlay Ribbon (if active)
    if (this.routeMesh && this.routeMesh.count > 0) {
      pass.setPipeline(this.routePipeline);
      pass.setBindGroup(0, this.pointBindGroup);
      pass.setVertexBuffer(0, this.routeMesh.vertBuf);
      pass.setVertexBuffer(1, this.routeMesh.colBuf);
      pass.setIndexBuffer(this.routeMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.routeMesh.count);
      this.lastDrawCallCount += 1;
    }

    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    if (this.terrainMesh) {
      this.terrainMesh.vertBuf.destroy();
      this.terrainMesh.colBuf.destroy();
      this.terrainMesh.idxBuf.destroy();
      this.terrainMesh = null;
    }
    this.clearPreviewMesh();
    this.clearRouteMesh();
    if (this.trajectoryBuffer) {
      this.trajectoryBuffer.destroy();
      this.trajectoryBuffer = null;
    }
    destroyPointChunks(this.leafChunks);
    destroyPointChunks(this.voxelChunks);
    this.leafChunks = [];
    this.voxelChunks = [];

    if (this.cameraBuffer) this.cameraBuffer.destroy();
    if (this.cameraBufferVoxel) this.cameraBufferVoxel.destroy();
    if (this.depthTexture) this.depthTexture.destroy();
    if (this.heightTexture) this.heightTexture.destroy();
    if (this.snowTexture) this.snowTexture.destroy();
    if (this.slopeTexture) this.slopeTexture.destroy();
    if (this.altitudeTexture) this.altitudeTexture.destroy();
    if (this.shadowTexture) this.shadowTexture.destroy();
    if (this.sunlightMapTexture) this.sunlightMapTexture.destroy();
    if (this.device) this.device.destroy();
  }
}
