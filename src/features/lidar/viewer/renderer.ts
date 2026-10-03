import type { PlatformProfile } from './lod/types';
import type { SceneNode, SceneNodeUploader } from './lod/sceneLod';
import { translateAppText } from '@/shared/i18n/config';
import { mat4MultiplyInto } from './renderer/math';
import { NodeGpuPool } from './renderer/nodePool';
import { resolvePlatformInfo } from './renderer/platform';
import { createRendererPipelines, SCENE_DEPTH_FORMAT, type RendererPipelines } from './renderer/rendererPipeline';
import { EDL_PARAMS_FLOATS, POINT_PARAMS_FLOATS } from './renderer/shaders';
import type { HeightmapParams, SnowParams } from './renderer/types';
import { buildSlopeRampData } from './slope/slopeRamp';
import { buildAltitudeRampData, DEFAULT_MAX_ALTITUDE_M } from './altitude/altitudeRamp';
import type { ViewerSlopeState, ViewerAltitudeState } from './rightPanel/types';
import type { ViewerPointFilterState } from './pointFilter';
import { computePointFilterBitmasks } from './pointFilter';
import type { SolarRenderState } from '../viewer-webgl/sunlightController';
import { GpuFrameTimer, TIMED_PASS } from './renderer/gpuTimer';

export type { HeightmapParams, SnowParams } from './renderer/types';
export type { ViewerSlopeState, ViewerAltitudeState, ViewerPointFilterState };

/** Point colouring: orthophoto/embedded RGB, uniform grey (relief only), LiDAR intensity, or classification. */
export type PointColorMode = 'rgb' | 'grey' | 'intensity' | 'classification';
const COLOR_MODE_INDEX: Record<PointColorMode, number> = { rgb: 0, intensity: 1, classification: 2, grey: 3 };

/** Projected point diameter bounds (device pixels) for the metre-sized mode. */
const POINT_MIN_PX = 1.0;
const POINT_MAX_PX = 64;
/**
 * Adaptive size of the finest points on screen, per metre of their node's
 * surface spacing: the same 1.5 × spacing the default point size gives the
 * full-density points (see `pointSizeReference`).
 */
const ADAPTIVE_SPACING_FACTOR = 1.5;
/** Uniform slots of the node pool (one per resident LOD node). */
const NODE_POOL_CAPACITY = 16384;

/** Offscreen scene render targets of one size. */
interface SceneTargets {
  width: number;
  height: number;
  /** Single-sample colour (MSAA resolve target), read by the EDL or upscale pass. */
  colorTexture: GPUTexture;
  colorView: GPUTextureView;
  colorMsTexture: GPUTexture | null;
  colorMsView: GPUTextureView | null;
  depthTexture: GPUTexture;
  depthView: GPUTextureView;
  edlBindGroup: GPUBindGroup;
  blitBindGroup: GPUBindGroup;
}

interface MeshBuffers {
  vertBuf: GPUBuffer;
  colBuf: GPUBuffer;
  idxBuf: GPUBuffer;
  count: number;
}

/**
 * WebGPU point-cloud renderer.
 *
 * Frame = shading compute pass (drawn nodes that are new, or stale after an
 * overlay change) → scene pass (depth32float reversed-Z, MSAA ×4 on
 * discrete GPUs), straight into the canvas, or with EDL on into an
 * offscreen target that the Eye-Dome Lighting pass resolves to the canvas.
 * Point data lives in LOD nodes streamed by `SceneLod`; this class is its
 * GPU residency backend (`SceneNodeUploader`).
 */
export class LidarRenderer implements SceneNodeUploader {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private pipelines!: RendererPipelines;
  private sampleCount = 1;
  private nodePool: NodeGpuPool | null = null;

  private cameraBuffer!: GPUBuffer;
  private pointParamsBuffer!: GPUBuffer;
  private edlParamsBuffer!: GPUBuffer;
  private sceneBindGroup!: GPUBindGroup;
  private pointParamsBindGroup!: GPUBindGroup;
  /** Canvas-sized targets (EDL path; without EDL the scene goes straight to the canvas). */
  private fullTargets: SceneTargets | null = null;
  /** Reduced targets drawn while the camera moves (`motionScale` < 1), upscaled to the canvas. */
  private motionTargets: SceneTargets | null = null;
  private blitSampler!: GPUSampler;
  /**
   * Scene resolution while the camera moves, as a share of the canvas
   * (1 = off). Fill rate is what limits integrated GPUs: 0.7 draws half
   * the pixels. Set before `resize`.
   */
  motionScale = 1;
  /** Square sprites (no discard) while the camera moves. */
  motionSquares = true;
  private lastRenderScale = 1;

  private uniformCache = new Float32Array(80);
  private uniformCacheU32 = new Uint32Array(this.uniformCache.buffer);
  private pointParams = new Float32Array(POINT_PARAMS_FLOATS);
  private edlParams = new Float32Array(EDL_PARAMS_FLOATS);

  private pointFilterEnabled = 0;
  private pointFilterMask: [number, number, number, number] = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
  private colorMode: PointColorMode = 'rgb';

  private trajectoryBuffer: GPUBuffer | null = null;
  private trajectoryVertexCount = 0;
  private trajectoryEnabled = false;
  private sunDiscPos: [number, number, number] | null = null;
  private sunDiscRadius = 0;

  private heightTexture!: GPUTexture;
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

  private _cachedViewProj = new Float32Array(16);
  private _lastView = new Float32Array(16);
  private _lastProj = new Float32Array(16);

  private terrainMesh: MeshBuffers | null = null;
  private previewMesh: MeshBuffers | null = null;
  private routeMesh: MeshBuffers | null = null;
  private canvasWidth = 1;
  private canvasHeight = 1;
  private hmOriginX = 0;
  private hmOriginZ = 0;
  private hmScaleX = 1;
  private hmScaleZ = 1;
  /** Point diameter in metres, identical for every point (projected, clamped in pixels). */
  pointSize = 0.3;
  /** Point diameter in device pixels; 0 = adaptive (world size, clamped in pixels). */
  fixedPointPixels = 0;
  /**
   * Coarser LOD levels drawn as the finest on screen grow to their own
   * spacing (Potree-style adaptive size): no holes where the budget or the
   * distance stops the refinement.
   */
  adaptivePointSize = true;
  /** Default `pointSize` of the scene; the adaptive size follows the user's changes to it. */
  pointSizeReference = 0;
  terrainVisible = true;

  private edlEnabled = false;
  private edlStrength = 1.0;
  private edlRadiusPx = 1.4;

  lastViewProj: Float32Array = new Float32Array(16);
  lastCamPos: Float32Array | [number, number, number] = new Float32Array(3);
  lastCamFwd: Float32Array | [number, number, number] = new Float32Array([0, 0, -1]);

  deviceLost = false;
  /** Called once when the device is lost for any reason other than `destroy()`. */
  onDeviceLost: ((info: GPUDeviceLostInfo) => void) | null = null;
  platform: PlatformProfile | null = null;
  /** proj[1][1] of the last camera update (LOD screen-size focal). */
  lastProjScaleY = 1;
  private gpuTimer: GpuFrameTimer | null = null;
  private lastDrawCallCount = 0;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) throw new Error(translateAppText('WebGPU non supporté'));
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error(translateAppText('Pas de GPUAdapter'));

    const { vendor, arch, desc, profile } = resolvePlatformInfo((adapter as unknown as { info?: unknown }).info ?? null);
    this.platform = profile;
    // MSAA ×4 (with alpha-to-coverage on point edges) only where fill rate is cheap.
    this.sampleCount = profile.tier === 'discrete' ? 4 : 1;

    console.log(`[LiDAR GPU] Adapter: vendor=${vendor} arch=${arch} desc=${desc}`);

    const features: GPUFeatureName[] = [];
    if (adapter.features.has('timestamp-query')) features.push('timestamp-query');

    this.device = await adapter.requestDevice({ requiredFeatures: features });
    this.gpuTimer = new GpuFrameTimer(this.device);
    console.log(
      `[LiDAR GPU] Tier: ${profile.tier} · MSAA ×${this.sampleCount}` +
      ` · frame timing: ${this.gpuTimer.usesTimestamps ? 'timestamp-query' : 'onSubmittedWorkDone'}`,
    );

    this.device.addEventListener('uncapturederror', (event) => {
      console.error('[LiDAR GPU] Uncaptured error:', (event as GPUUncapturedErrorEvent).error.message);
    });

    this.device.lost.then((info) => {
      console.error(`[LiDAR GPU] Device lost: reason=${info.reason}, message=${info.message}`);
      this.deviceLost = true;
      if (info.reason !== 'destroyed') {
        const statusEl = document.getElementById('status');
        const overlay = document.getElementById('overlay');
        if (statusEl) statusEl.textContent = translateAppText('⚠️ Périphérique GPU perdu : {{reason}}. Rechargez la page.', { reason: info.message || info.reason });
        if (overlay) overlay.classList.remove('hidden');
        this.onDeviceLost?.(info);
      }
    });

    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    this.pipelines = await createRendererPipelines(this.device, this.format, this.sampleCount);
    this.nodePool = new NodeGpuPool(
      this.device,
      this.pipelines.nodeBindGroupLayout,
      this.pipelines.shadingBindGroupLayout,
      NODE_POOL_CAPACITY,
    );

    this.cameraBuffer = this.createUniformBuffer(this.uniformCache.byteLength);
    this.pointParamsBuffer = this.createUniformBuffer(this.pointParams.byteLength);
    this.edlParamsBuffer = this.createUniformBuffer(this.edlParams.byteLength);
    this.pointParamsBindGroup = this.device.createBindGroup({
      layout: this.pipelines.pointParamsBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pointParamsBuffer } },
        { binding: 1, resource: { buffer: this.nodePool.childMaskBuffer } },
      ],
    });

    this.heightTexture = this.createFloatTexture(1, 1, new Float32Array([0]));
    this.snowTexture = this.createFloatTexture(1, 1, new Float32Array([0]));
    this.shadowTexture = this.createFloatTexture(1, 1, new Float32Array([0]));
    this.slopeTexture = this.createRampTexture(256);
    this.altitudeTexture = this.createRampTexture(512);
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
    this.blitSampler = this.createRampSampler('linear');
    this.slopeSampler = this.createRampSampler('linear');
    this.altitudeSampler = this.createRampSampler('linear');

    this.rebuildBindGroups();
    this.resize(canvas.width, canvas.height);
  }

  /** Smoothed GPU cost of the draw passes per frame in ms (0 until measured), see `GpuFrameTimer`. */
  getGpuFrameMs(): number {
    return this.gpuTimer?.getFrameMs() ?? 0;
  }

  /** Smoothed GPU cost of the point shading pass per frame in ms (0 until measured). */
  getGpuShadeMs(): number {
    return this.gpuTimer?.getShadeMs() ?? 0;
  }

  /** False when frame cost is only approximated (no `timestamp-query`): includes presentation waits. */
  hasPreciseGpuTiming(): boolean {
    return this.gpuTimer?.usesTimestamps ?? false;
  }

  getLastRenderStats(): { drawCalls: number; outOfMemory: number } {
    return { drawCalls: this.lastDrawCallCount, outOfMemory: this.nodePool?.outOfMemoryCount ?? 0 };
  }

  /** Max LOD nodes the GPU pool can hold at once (uniform slots). */
  getNodeCapacity(): number {
    return this.nodePool?.capacity ?? 0;
  }

  get msaaSamples(): number {
    return this.sampleCount;
  }

  /**
   * Drops MSAA (first step of the automatic quality downgrade on a GPU that
   * stays too slow at the minimum point budget). Resolves to false when it
   * was already off.
   */
  async disableMsaa(): Promise<boolean> {
    if (this.sampleCount === 1 || !this.device || this.deviceLost) return false;
    this.pipelines = await createRendererPipelines(this.device, this.format, 1, this.pipelines);
    this.sampleCount = 1;
    this.resize(this.canvasWidth, this.canvasHeight);
    console.log('[LiDAR GPU] MSAA disabled to keep the frame rate.');
    return true;
  }

  // --- SceneNodeUploader ---

  uploadNode(node: SceneNode, block: ArrayBuffer): boolean {
    if (!this.nodePool || this.deviceLost) return false;
    return this.nodePool.upload(node, block);
  }

  releaseNode(node: SceneNode): void {
    this.nodePool?.release(node);
  }

  /**
   * Eye-Dome Lighting: `strength` ≈ 1 matches CloudCompare/Potree defaults,
   * `radiusPx` is in device pixels (scale it with the canvas pixel ratio).
   */
  setEdl(enabled: boolean, strength: number, radiusPx: number): void {
    this.edlEnabled = enabled;
    this.edlStrength = Math.max(0, strength);
    this.edlRadiusPx = Math.max(1, radiusPx);
  }

  setColorMode(mode: PointColorMode): void {
    if (mode === this.colorMode) return;
    this.colorMode = mode;
    this.invalidateShading();
  }

  getColorMode(): PointColorMode {
    return this.colorMode;
  }

  private invalidateShading(): void {
    this.nodePool?.invalidateShading();
  }

  private createUniformBuffer(size: number): GPUBuffer {
    return this.device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private createFloatTexture(width: number, height: number, data: Float32Array): GPUTexture {
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      data as Float32Array<ArrayBuffer>,
      { bytesPerRow: width * 4 },
      { width, height },
    );
    return texture;
  }

  private createRampTexture(width: number): GPUTexture {
    const texture = this.device.createTexture({
      size: [width, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array(width * 4) as Uint8Array<ArrayBuffer>,
      { bytesPerRow: width * 4 },
      { width, height: 1 },
    );
    return texture;
  }

  private createRampSampler(filter: GPUFilterMode): GPUSampler {
    return this.device.createSampler({
      magFilter: filter,
      minFilter: filter,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  private rebuildBindGroups() {
    this.sceneBindGroup = this.device.createBindGroup({
      layout: this.pipelines.sceneBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 3, resource: this.snowTexture.createView() },
        { binding: 4, resource: this.slopeTexture.createView() },
        { binding: 5, resource: this.slopeSampler },
        { binding: 6, resource: this.altitudeTexture.createView() },
        { binding: 7, resource: this.altitudeSampler },
        { binding: 8, resource: this.shadowTexture.createView() },
        { binding: 9, resource: this.sunlightMapTexture.createView() },
      ],
    });
    this.invalidateShading();
  }

  setHeightmap(params: HeightmapParams) {
    this.hmOriginX = params.originX;
    this.hmOriginZ = params.originZ;
    this.hmScaleX = params.scaleX;
    this.hmScaleZ = params.scaleZ;

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

    this.heightTexture.destroy();
    this.heightTexture = this.createFloatTexture(w, h, flipped);
    this.rebuildBindGroups();
  }

  setSnow(params: SnowParams) {
    this.snowTexture.destroy();
    this.snowTexture = this.createFloatTexture(params.width, params.height, params.data);
    this.snowOriginX = params.originX;
    this.snowOriginZ = params.originZ;
    this.snowScaleX = params.scaleX;
    this.snowScaleZ = params.scaleZ;
    this.rebuildBindGroups();
  }

  setSnowMode(mode: 0 | 1 | 2) {
    if (this.snowMode !== mode) this.invalidateShading();
    this.snowMode = mode;
  }

  setSlopeState(state: ViewerSlopeState): void {
    if (!this.device || this.deviceLost) return;
    this.slopeEnabled = state.enabled ? 1 : 0;
    this.slopeOpacity = (state.opacity ?? 50) / 100;
    const desiredFilter: GPUFilterMode = state.colorization === 'stepped' ? 'nearest' : 'linear';

    if (state.bands && state.bands.length > 0) {
      const data = buildSlopeRampData(state.bands, state.colorization, 256);
      this.device.queue.writeTexture(
        { texture: this.slopeTexture },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: 256 * 4 },
        { width: 256, height: 1 },
      );
    }

    if (this.slopeFilter !== desiredFilter) {
      this.slopeFilter = desiredFilter;
      this.slopeSampler = this.createRampSampler(desiredFilter);
      this.rebuildBindGroups();
    }
    this.invalidateShading();
  }

  setAltitudeState(state: ViewerAltitudeState): void {
    if (!this.device || this.deviceLost) return;
    this.altitudeEnabled = state.enabled ? 1 : 0;
    this.altitudeOpacity = (state.opacity ?? 50) / 100;
    const desiredFilter: GPUFilterMode = state.colorization === 'stepped' ? 'nearest' : 'linear';

    if (state.bands && state.bands.length > 0) {
      const data = buildAltitudeRampData(state.bands, state.colorization, this.maxAltitude, 512);
      this.device.queue.writeTexture(
        { texture: this.altitudeTexture },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: 512 * 4 },
        { width: 512, height: 1 },
      );
    }

    if (this.altitudeFilter !== desiredFilter) {
      this.altitudeFilter = desiredFilter;
      this.altitudeSampler = this.createRampSampler(desiredFilter);
      this.rebuildBindGroups();
    }
    this.invalidateShading();
  }

  setMaxAltitude(maxAltitude: number): void {
    this.maxAltitude = maxAltitude;
    this.invalidateShading();
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

    if (renderState.shadowMapData && renderState.shadowMapWidth > 0 && renderState.shadowMapHeight > 0) {
      const sw = renderState.shadowMapWidth;
      const sh = renderState.shadowMapHeight;
      const f32Shadow = new Float32Array(sw * sh);
      for (let i = 0; i < sw * sh; i++) {
        f32Shadow[i] = renderState.shadowMapData[i]! / 255;
      }
      this.shadowTexture.destroy();
      this.shadowTexture = this.createFloatTexture(sw, sh, f32Shadow);
      needsRebind = true;
    }

    if (renderState.sunlightMapRgba && renderState.sunlightMapWidth > 0 && renderState.sunlightMapHeight > 0) {
      const mw = renderState.sunlightMapWidth;
      const mh = renderState.sunlightMapHeight;
      this.sunlightMapTexture.destroy();
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

    if (needsRebind) this.rebuildBindGroups();

    this.trajectoryEnabled = renderState.trajectoryEnabled;
    this.sunDiscPos = renderState.sunDiscPos;
    this.sunDiscRadius = renderState.sunDiscRadius;

    if (renderState.trajectoryVertices && renderState.trajectoryVertexCount > 0) {
      this.trajectoryBuffer?.destroy();
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
    this.invalidateShading();
  }

  resize(w: number, h: number) {
    this.canvasWidth = Math.max(1, w);
    this.canvasHeight = Math.max(1, h);
    if (!this.device) return;

    this.destroySceneTargets(this.fullTargets);
    this.destroySceneTargets(this.motionTargets);
    this.fullTargets = this.createSceneTargets(this.canvasWidth, this.canvasHeight);
    this.motionTargets = this.motionScale < 1
      ? this.createSceneTargets(
        Math.max(1, Math.round(this.canvasWidth * this.motionScale)),
        Math.max(1, Math.round(this.canvasHeight * this.motionScale)),
      )
      : null;
  }

  private createSceneTargets(width: number, height: number): SceneTargets {
    const size = [width, height];
    const colorTexture = this.device.createTexture({
      size,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const colorView = colorTexture.createView();
    const colorMsTexture = this.sampleCount > 1
      ? this.device.createTexture({
        size,
        format: this.format,
        sampleCount: this.sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      : null;
    const depthTexture = this.device.createTexture({
      size,
      format: SCENE_DEPTH_FORMAT,
      sampleCount: this.sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const depthView = depthTexture.createView();
    return {
      width,
      height,
      colorTexture,
      colorView,
      colorMsTexture,
      colorMsView: colorMsTexture?.createView() ?? null,
      depthTexture,
      depthView,
      edlBindGroup: this.device.createBindGroup({
        layout: this.pipelines.edlBindGroupLayout,
        entries: [
          { binding: 0, resource: colorView },
          { binding: 1, resource: depthView },
          { binding: 2, resource: { buffer: this.edlParamsBuffer } },
        ],
      }),
      blitBindGroup: this.device.createBindGroup({
        layout: this.pipelines.blitBindGroupLayout,
        entries: [
          { binding: 0, resource: colorView },
          { binding: 1, resource: this.blitSampler },
        ],
      }),
    };
  }

  private destroySceneTargets(targets: SceneTargets | null): void {
    if (!targets) return;
    targets.colorTexture.destroy();
    targets.colorMsTexture?.destroy();
    targets.depthTexture.destroy();
  }

  private createMeshBuffers(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count: number): MeshBuffers {
    const vertBuf = this.device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertBuf, 0, vertices as Float32Array<ArrayBuffer>);
    const colBuf = this.device.createBuffer({ size: colors.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(colBuf, 0, colors as Uint8Array<ArrayBuffer>);
    const idxBuf = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(idxBuf, 0, indices as Uint32Array<ArrayBuffer>);
    return { vertBuf, colBuf, idxBuf, count };
  }

  private static destroyMesh(mesh: MeshBuffers | null): void {
    if (!mesh) return;
    mesh.vertBuf.destroy();
    mesh.colBuf.destroy();
    mesh.idxBuf.destroy();
  }

  setMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    this.setTerrainMesh({ vertices, colors, indices, count: count ?? indices.length });
  }

  setTerrainMesh(mesh: { vertices: Float32Array; colors: Uint8Array; indices: Uint32Array; count: number }) {
    LidarRenderer.destroyMesh(this.terrainMesh);
    this.terrainMesh = this.createMeshBuffers(mesh.vertices, mesh.colors, mesh.indices, mesh.count);
  }

  setPreviewMesh(
    meshOrVertices: { vertices: Float32Array; colors: Uint8Array; indices: Uint32Array; count: number } | Float32Array,
    colors?: Uint8Array,
    indices?: Uint32Array,
  ) {
    if (meshOrVertices instanceof Float32Array) {
      if (!colors || !indices) return;
      this.clearPreviewMesh();
      this.previewMesh = this.createMeshBuffers(meshOrVertices, colors, indices, indices.length);
      return;
    }
    this.clearPreviewMesh();
    this.previewMesh = this.createMeshBuffers(
      meshOrVertices.vertices,
      meshOrVertices.colors,
      meshOrVertices.indices,
      meshOrVertices.count,
    );
  }

  clearPreviewMesh(): void {
    LidarRenderer.destroyMesh(this.previewMesh);
    this.previewMesh = null;
  }

  setRouteMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    this.clearRouteMesh();
    if (!this.device || vertices.length === 0 || indices.length === 0) return;
    this.routeMesh = this.createMeshBuffers(vertices, colors, indices, count ?? indices.length);
  }

  setPointFilterState(state: ViewerPointFilterState): void {
    this.pointFilterEnabled = state.enabled ? 1.0 : 0.0;
    this.pointFilterMask = computePointFilterBitmasks(state.enabled, state.categories);
  }

  clearRouteMesh(): void {
    LidarRenderer.destroyMesh(this.routeMesh);
    this.routeMesh = null;
  }

  /**
   * @param projMat render projection (reversed-Z, infinite far: see
   *   `CameraController.getRenderProjMatrix`). Its row 3 equals the standard
   *   one, so LOD screen sizes and frustum culling are unaffected.
   */
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
    this.lastProjScaleY = pArr[5]!;

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

    const f = this.uniformCache;

    // 0..15: viewProj
    mat4MultiplyInto(this._cachedViewProj, pArr, vArr);
    f.set(this._cachedViewProj, 0);
    this.lastViewProj.set(this._cachedViewProj);

    // 16..19: right, 20..23: up, 24..27: cameraPos
    f[16] = vArr[0]!; f[17] = vArr[4]!; f[18] = vArr[8]!; f[19] = 0;
    f[20] = vArr[1]!; f[21] = vArr[5]!; f[22] = vArr[9]!; f[23] = 0;
    f[24] = cpx; f[25] = cpy; f[26] = cpz; f[27] = 1;

    // 28..31: scalars
    f[28] = this.pointSize;
    f[29] = 0;
    f[30] = this.canvasWidth;
    f[31] = this.canvasHeight;

    // 32..35: sunDir
    const sunLen = Math.hypot(this.sunDir[0], this.sunDir[1], this.sunDir[2]) || 1;
    f[32] = this.sunDir[0] / sunLen;
    f[33] = this.sunDir[1] / sunLen;
    f[34] = this.sunDir[2] / sunLen;
    f[35] = 0;

    // 36..39: heightmap params
    f[36] = this.hmOriginX; f[37] = this.hmOriginZ; f[38] = this.hmScaleX; f[39] = this.hmScaleZ;

    // 40..43: density, altitude params, colour mode
    f[40] = density; f[41] = this.centerAltitude; f[42] = this.maxAltitude; f[43] = COLOR_MODE_INDEX[this.colorMode];

    // 44..48: snow params
    f[44] = this.snowMode;
    f[45] = this.snowOriginX; f[46] = this.snowOriginZ; f[47] = this.snowScaleX; f[48] = this.snowScaleZ;

    // 49..52: slope and altitude state
    f[49] = this.slopeEnabled; f[50] = this.slopeOpacity; f[51] = this.altitudeEnabled; f[52] = this.altitudeOpacity;

    // 53..59: sunlight params
    f[53] = this.sunlightEnabled;
    f[54] = this.shadowEnabled;
    f[55] = this.shadowOpacity;
    f[56] = this.sunlightMapEnabled;
    f[57] = this.sunlightMapOpacity;
    f[58] = this.sunIntensity;
    f[59] = this.exposure;

    // 60..67: sun & sky colours
    f[60] = this.sunColor[0]; f[61] = this.sunColor[1]; f[62] = this.sunColor[2]; f[63] = 1.0;
    f[64] = this.skyColor[0]; f[65] = this.skyColor[1]; f[66] = this.skyColor[2]; f[67] = 1.0;

    // 68..71: sun disc
    if (this.sunDiscPos) {
      f[68] = this.sunDiscPos[0]; f[69] = this.sunDiscPos[1]; f[70] = this.sunDiscPos[2]; f[71] = this.sunDiscRadius;
    } else {
      f[68] = 0; f[69] = 0; f[70] = 0; f[71] = 0;
    }

    // 72..75: point filter params, 76..79: bitmask (u32 words)
    f[72] = this.pointFilterEnabled; f[73] = 0; f[74] = 0; f[75] = 0;
    this.uniformCacheU32[76] = this.pointFilterMask[0] >>> 0;
    this.uniformCacheU32[77] = this.pointFilterMask[1] >>> 0;
    this.uniformCacheU32[78] = this.pointFilterMask[2] >>> 0;
    this.uniformCacheU32[79] = this.pointFilterMask[3] >>> 0;

    this.device.queue.writeBuffer(this.cameraBuffer, 0, f as Float32Array<ArrayBuffer>);
  }

  /** Per-frame sprite and EDL parameters for scene targets of `width`×`height` (`scale` of the canvas). */
  private writeFrameParams(width: number, height: number, scale: number): void {
    const p = this.pointParams;
    // Pixel sizes follow the target, so the upscaled image keeps the same point sizes.
    p[0] = POINT_MIN_PX;
    p[1] = POINT_MAX_PX * scale;
    p[2] = this.fixedPointPixels * scale;
    p[3] = Math.abs(this.lastProjScaleY) * height * 0.5;
    p[4] = width;
    p[5] = height;
    p[6] = this.sampleCount > 1 ? 1 : 0;
    p[7] = this.pointSize;
    p[8] = this.adaptivePointSize
      ? ADAPTIVE_SPACING_FACTOR * (this.pointSizeReference > 0 ? this.pointSize / this.pointSizeReference : 1)
      : 0;
    this.device.queue.writeBuffer(this.pointParamsBuffer, 0, p as Float32Array<ArrayBuffer>);

    this.edlParams[0] = this.edlStrength;
    this.edlParams[1] = Math.max(1, this.edlRadiusPx * scale);
    this.edlParams[2] = this.edlEnabled ? 1 : 0;
    this.edlParams[3] = scale;
    this.device.queue.writeBuffer(this.edlParamsBuffer, 0, this.edlParams as Float32Array<ArrayBuffer>);
  }

  /** Share of the canvas resolution the last frame was rendered at. */
  getLastRenderScale(): number {
    return this.lastRenderScale;
  }

  /**
   * Renders the terrain, the given LOD nodes (front to back) and overlays.
   * `motion`: the camera is moving — reduced resolution (`motionScale`) and
   * square sprites; the next still frame restores full quality.
   */
  renderScene(nodes: readonly SceneNode[], options: { motion?: boolean } = {}): void {
    if (!this.device || this.deviceLost || !this.fullTargets || !this.nodePool) return;

    const canvasView = this.context.getCurrentTexture().createView();
    this.lastDrawCallCount = 0;
    const reduced = options.motion === true && this.motionTargets !== null;
    const targets = reduced ? this.motionTargets! : this.fullTargets;
    const scale = targets.width / this.canvasWidth;
    this.lastRenderScale = scale;
    this.writeFrameParams(targets.width, targets.height, scale);

    const clearR = this.sunlightEnabled ? this.skyColor[0] : 0.76;
    const clearG = this.sunlightEnabled ? this.skyColor[1] : 0.87;
    const clearB = this.sunlightEnabled ? this.skyColor[2] : 0.96;

    const enc = this.device.createCommandEncoder();
    const timed = this.gpuTimer?.beginFrame() ?? false;
    this.nodePool.prepareFrame(
      enc,
      this.pipelines.shadingPipeline,
      this.sceneBindGroup,
      nodes,
      timed ? () => this.gpuTimer!.passTimestamps(TIMED_PASS.shading) : undefined,
    );

    const msaa = targets.colorMsView !== null;
    // At full resolution without EDL the scene goes straight to the canvas
    // (resolved there with MSAA): no full-screen copy. Depth is only stored
    // for EDL.
    const direct = !this.edlEnabled && !reduced;
    const target = direct ? canvasView : targets.colorView;
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: msaa ? targets.colorMsView! : target,
        resolveTarget: msaa ? target : undefined,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1 },
        loadOp: 'clear',
        storeOp: msaa ? 'discard' : 'store',
      }],
      depthStencilAttachment: {
        view: targets.depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: this.edlEnabled ? 'store' : 'discard',
      },
      timestampWrites: timed ? this.gpuTimer!.passTimestamps(TIMED_PASS.scene) : undefined,
    });
    pass.setBindGroup(0, this.sceneBindGroup);

    // Points first (front to back), then the terrain only fills what is left.
    pass.setPipeline(options.motion && this.motionSquares ? this.pipelines.pointPipelineSquare : this.pipelines.pointPipeline);
    pass.setBindGroup(1, this.pointParamsBindGroup);
    this.lastDrawCallCount += this.nodePool.draw(pass, nodes);

    if (this.terrainMesh && this.terrainVisible) {
      pass.setPipeline(this.pipelines.terrainPipeline);
      pass.setVertexBuffer(0, this.terrainMesh.vertBuf);
      pass.setVertexBuffer(1, this.terrainMesh.colBuf);
      pass.setIndexBuffer(this.terrainMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.terrainMesh.count);
      this.lastDrawCallCount += 1;
    }

    if (this.previewMesh) {
      pass.setPipeline(this.pipelines.previewPipeline);
      pass.setVertexBuffer(0, this.previewMesh.vertBuf);
      pass.setVertexBuffer(1, this.previewMesh.colBuf);
      pass.setIndexBuffer(this.previewMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.previewMesh.count);
      this.lastDrawCallCount += 1;
    }

    if (this.trajectoryEnabled && this.trajectoryVertexCount > 1 && this.trajectoryBuffer) {
      pass.setPipeline(this.pipelines.trajectoryPipeline);
      pass.setVertexBuffer(0, this.trajectoryBuffer);
      pass.draw(this.trajectoryVertexCount, 1, 0, 0);
      this.lastDrawCallCount += 1;
    }

    if (this.trajectoryEnabled && this.sunDiscPos) {
      pass.setPipeline(this.pipelines.sunDiscPipeline);
      pass.draw(6, 1, 0, 0);
      this.lastDrawCallCount += 1;
    }

    if (this.routeMesh && this.routeMesh.count > 0) {
      pass.setPipeline(this.pipelines.routePipeline);
      pass.setVertexBuffer(0, this.routeMesh.vertBuf);
      pass.setVertexBuffer(1, this.routeMesh.colBuf);
      pass.setIndexBuffer(this.routeMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.routeMesh.count);
      this.lastDrawCallCount += 1;
    }
    pass.end();

    if (!direct) {
      const edlPass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: clearR, g: clearG, b: clearB, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        timestampWrites: timed ? this.gpuTimer!.passTimestamps(TIMED_PASS.edl) : undefined,
      });
      if (this.edlEnabled) {
        edlPass.setPipeline(this.pipelines.edlPipeline);
        edlPass.setBindGroup(0, targets.edlBindGroup);
      } else {
        edlPass.setPipeline(this.pipelines.blitPipeline);
        edlPass.setBindGroup(0, targets.blitBindGroup);
      }
      edlPass.draw(3);
      edlPass.end();
    }

    if (timed) this.gpuTimer!.encodeResolve(enc);
    this.device.queue.submit([enc.finish()]);
    this.gpuTimer?.afterSubmit();
  }

  destroy(): void {
    this.gpuTimer?.destroy();
    this.gpuTimer = null;
    LidarRenderer.destroyMesh(this.terrainMesh);
    this.terrainMesh = null;
    this.clearPreviewMesh();
    this.clearRouteMesh();
    this.trajectoryBuffer?.destroy();
    this.trajectoryBuffer = null;
    this.nodePool?.destroy();
    this.nodePool = null;

    this.cameraBuffer?.destroy();
    this.pointParamsBuffer?.destroy();
    this.edlParamsBuffer?.destroy();
    this.destroySceneTargets(this.fullTargets);
    this.destroySceneTargets(this.motionTargets);
    this.fullTargets = null;
    this.motionTargets = null;
    this.heightTexture?.destroy();
    this.snowTexture?.destroy();
    this.slopeTexture?.destroy();
    this.altitudeTexture?.destroy();
    this.shadowTexture?.destroy();
    this.sunlightMapTexture?.destroy();
    this.device?.destroy();
  }
}
