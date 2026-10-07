// ============================================
// Photo mode — frame orchestration (WebGPU)
// ============================================
//
// Owned by WebGpuLidarRenderer, which hands over `renderScene` while the
// mode is on. A frame:
//   tables (atmosphere, cloud noises, light volume, shadow maps) when stale
//   → G-buffer (points + DTM: albedo, class, depth) and overlays
//   → deferred lighting, accumulated over the still frames (direct, ambient)
//   → clouds (moving: half resolution, temporal; still: full resolution,
//   accumulated until clean) → composite (cloud shadows, aerial perspective,
//   sky, clouds) → bloom → AgX → canvas.
// With `reuseScene` (still view already accumulated, clouds still
// converging) only the clouds and what follows run: the points are not
// drawn again.
// Every GPU resource is created when the mode starts and freed when it ends.

import type { SceneNode } from '../../lod/sceneLod';
import type { AABB, GpuTier } from '../../lod/types';
import { LOD_POINT_STRIDE } from '../../lod/lodTile';
import type { NodeGpuPool } from '../../renderer/nodePool';
import type { TerrainLod } from '../../renderer/terrainLod';
import type { MeshBuffers } from '../../renderer/gpuResources';
import { TIMED_PASS, type GpuFrameTimer } from '../../renderer/gpuTimer';
import { POINT_SHADER, ROUTE_SHADER, TERRAIN_SHADER } from '../../renderer/shaders';
import { fitLightToBox, fitLightToSquare, type Vec3 } from '../lib/shadowFit';
import { invertMat4 } from '../lib/mat4';
import { CLOUD_DROPLET_DIAMETER_UM, mieFitForDiameter } from '../lib/phase';
import { hasClouds, type HighCloudLayer } from '../lib/cloudPresets';
import { bindGroup, bindGroupLayout, buffer } from './gpuLayouts';
import { packPhotoUniforms, type PhotoUniformValues } from './photoUniforms';
import { PhotoAtmosphere } from './photoAtmosphere';
import { PhotoClouds } from './photoClouds';
import { PhotoShadows, SHADOW_MAP } from './photoShadows';
import { PHOTO_UNIFORM_FLOATS } from './shaders/photoCommon';
import { AERIAL_PERSPECTIVE_MAX_KM, PHOTO_LIGHTING_BYTES } from './shaders/atmosphereShaders';
import { CLOUD_DOMAIN_HALF_M, CLOUD_FULL_RADIUS_M } from './shaders/cloudShaders';
import { LIGHTING_SHADER } from './shaders/lightingShader';
import { BLOOM_LEVELS, BLOOM_SHADER, COMPOSITE_SHADER, FINAL_SHADER } from './shaders/compositeShaders';
import type { PhotoCasterSource, PhotoModeRenderer, PhotoRenderSettings, PhotoSceneInfo } from './types';

const GBUFFER_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** Weight of a freshly traced cloud pixel while the view moves. */
const CLOUD_MOVING_WEIGHT = 0.35;
/** Margin of the ground shadow map around the scene's footprint on the base plane (m). */
const CLOUD_SHADOW_MARGIN_M = 600;
const SUN_TAN_RADIUS = 0.004653;
const SCREEN_OCCLUSION_STRENGTH = 0.1;
const BLOOM_STRENGTH = 0.05;

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ACCUMULATE_BLEND: GPUBlendState = {
  color: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
  alpha: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
};
const ADD_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};
const TERRAIN_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 24,
    stepMode: 'vertex',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
    ],
  },
  { arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x4' }] },
];

/**
 * Per GPU class: sizes of the shadow maps (cascade 0, cascade 1, surface
 * model), caster budget, cloud steps per ray while moving, and the still
 * accumulation of the clouds — pixels per block traced in turn (bounds the
 * cost of a frame) and samples per pixel.
 */
const TIER_SETTINGS: Record<GpuTier, {
  maps: [number, number, number];
  casters: number;
  cloudSteps: number;
  stillInterleave: 1 | 2 | 4;
  stillSamples: number;
}> = {
  discrete: { maps: [4096, 4096, 2048], casters: 12_000_000, cloudSteps: 160, stillInterleave: 1, stillSamples: 48 },
  apple: { maps: [4096, 4096, 2048], casters: 8_000_000, cloudSteps: 128, stillInterleave: 2, stillSamples: 40 },
  integrated: { maps: [3072, 2048, 1024], casters: 5_000_000, cloudSteps: 96, stillInterleave: 4, stillSamples: 32 },
  software: { maps: [1024, 1024, 512], casters: 1_000_000, cloudSteps: 48, stillInterleave: 4, stillSamples: 8 },
};

/** What the WebGPU renderer shares with the photo mode. */
export interface PhotoRendererHost {
  device: GPUDevice;
  canvasFormat: GPUTextureFormat;
  tier: GpuTier;
  nodePool: NodeGpuPool;
  layouts: {
    scene: GPUBindGroupLayout;
    pointParams: GPUBindGroupLayout;
    node: GPUBindGroupLayout;
    terrainLod: GPUBindGroupLayout;
  };
  timer: GpuFrameTimer | null;
}

export interface PhotoFrame {
  encoder: GPUCommandEncoder;
  canvasView: GPUTextureView;
  canvasWidth: number;
  canvasHeight: number;
  /** The camera moves: reduced resolution and square sprites. */
  motion: boolean;
  squares: boolean;
  motionScale: number;
  /** Still-frame index of the accumulation, −1 when not accumulating. */
  accumulate: number;
  /** Still view already accumulated: only the clouds and what follows. */
  reuseScene: boolean;
  nodes: readonly SceneNode[];
  /** Matrix the scene is drawn with (sub-pixel jitter while accumulating). */
  drawViewProj: Float32Array;
  viewProj: Float32Array;
  camPos: ArrayLike<number>;
  sceneBindGroup: GPUBindGroup;
  pointParamsBindGroup: GPUBindGroup;
  terrain: TerrainLod | null;
  terrainVisible: boolean;
  overlays: { preview: MeshBuffers | null; route: MeshBuffers | null; analysis: MeshBuffers | null };
  heightTexture: GPUTexture;
  heightmap: readonly [number, number, number, number];
  pointSizeM: number;
  pointFilter: { enabled: boolean; mask: readonly [number, number, number, number] };
  /** Writes the sprite parameters for a target of `width`×`height` at `scale` of the canvas. */
  writePointParams(width: number, height: number, scale: number): void;
  timed: boolean;
}

interface PhotoTargets {
  width: number;
  height: number;
  albedo: GPUTexture;
  material: GPUTexture;
  overlay: GPUTexture;
  depth: GPUTexture;
  direct: GPUTexture;
  ambient: GPUTexture;
  hdr: GPUTexture;
  bloom: GPUTexture[];
  depthView: GPUTextureView;
  hasOverlay: boolean;
  /** Bind groups built against this target (cache keys inside). */
  lightingGroup: GPUBindGroup | null;
  lightingKey: unknown[];
  /** One composite group per cloud buffer (they alternate). */
  compositeGroups: Map<GPUTexture, GPUBindGroup>;
  finalGroup: GPUBindGroup | null;
  bloomDownGroups: GPUBindGroup[];
  bloomUpGroups: GPUBindGroup[];
}

interface CaptureRequest {
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  texture?: GPUTexture;
  buffer?: GPUBuffer;
  bytesPerRow?: number;
  width?: number;
  height?: number;
}

/**
 * `?photoDebug=<n>`: 1 direct light, 2 ambient, 3 sun shadows, 4 clouds, 7 cloud shadow on the scene,
 * 5 normals, 6 occlusion; the lighting values are logged once. 0 = off.
 */
function readDebugView(): number {
  if (typeof location === 'undefined') return 0;
  const value = Number(new URLSearchParams(location.search).get('photoDebug'));
  return Number.isInteger(value) && value >= 0 && value <= 9 ? value : 0;
}

interface CloudShadowArea {
  centreX: number;
  centreZ: number;
  halfSizeM: number;
  /** Radius of the scene's footprint on the base plane: the cumulus leave it clear (subject in the sun). */
  subjectRadiusM: number;
}

/**
 * Area of the ground shadow map on the cloud base plane: the scene's
 * footprint seen from the sun (each ground point projects along the sun
 * ray onto the base; the relief spreads it along the sun's azimuth).
 */
function cloudShadowArea(sun: readonly [number, number, number], scene: PhotoSceneInfo, baseAltitudeM: number): CloudShadowArea {
  const ly = Math.max(sun[1], 0.05);
  const b = scene.bounds;
  const midAlt = (scene.minAltitudeM + scene.maxAltitudeM) / 2;
  const reach = Math.max(0, baseAltitudeM - midAlt) / ly;
  const spread = (Math.max(0, scene.maxAltitudeM - scene.minAltitudeM) / ly) * Math.hypot(sun[0], sun[2]);
  const halfXZ = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
  return {
    centreX: (b.minX + b.maxX) / 2 + sun[0] * reach,
    centreZ: (b.minZ + b.maxZ) / 2 + sun[2] * reach,
    halfSizeM: Math.min(8000, Math.max(1500, halfXZ + spread / 2 + CLOUD_SHADOW_MARGIN_M)),
    // Only the tiles themselves: clouds may stand right beside them (the
    // light corridor still keeps the towers towards the sun low enough).
    subjectRadiusM: Math.min(1500, halfXZ + 250),
  };
}

/** Horizontal direction towards the sun (unit) and the tangent of its altitude, for the light corridor. */
function sunCorridor(sun: readonly [number, number, number]): { sunX: number; sunZ: number; sunTanAltitude: number } {
  const horizontal = Math.hypot(sun[0], sun[2]);
  if (horizontal < 1e-4) return { sunX: 1, sunZ: 0, sunTanAltitude: 1e3 };
  return { sunX: sun[0] / horizontal, sunZ: sun[2] / horizontal, sunTanAltitude: Math.max(sun[1], 0.02) / horizontal };
}

function highUniform(layer: HighCloudLayer): [number, number, number, number] {
  return [layer.baseAltitudeM, layer.thicknessM, layer.coverage, layer.type];
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function matricesEqual(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

class PhotoResources {
  readonly uniforms: GPUBuffer;
  readonly lighting: GPUBuffer;
  readonly linearClamp: GPUSampler;
  readonly shadowCmp: GPUSampler;
  readonly atmosphere: PhotoAtmosphere;
  readonly clouds: PhotoClouds;
  readonly shadows: PhotoShadows;
  readonly gbufferPoint: GPURenderPipeline;
  readonly gbufferSquare: GPURenderPipeline;
  readonly gbufferTerrain: GPURenderPipeline;
  readonly overlayRoute: GPURenderPipeline;
  readonly overlayPreview: GPURenderPipeline;
  readonly lightingPipeline: GPURenderPipeline;
  readonly compositePipeline: GPURenderPipeline;
  readonly bloomDownFirst: GPURenderPipeline;
  readonly bloomDown: GPURenderPipeline;
  readonly bloomUp: GPURenderPipeline;
  readonly finalPipeline: GPURenderPipeline;
  readonly lightingLayout: GPUBindGroupLayout;
  readonly compositeLayout: GPUBindGroupLayout;
  readonly bloomLayout: GPUBindGroupLayout;
  readonly finalLayout: GPUBindGroupLayout;

  constructor(host: PhotoRendererHost) {
    const { device } = host;
    const tier = TIER_SETTINGS[host.tier];
    this.uniforms = device.createBuffer({ size: PHOTO_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lighting = device.createBuffer({ size: PHOTO_LIGHTING_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.linearClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    this.shadowCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.atmosphere = new PhotoAtmosphere(device, this.uniforms, this.lighting, this.linearClamp);
    this.clouds = new PhotoClouds(device, this.uniforms, this.lighting, this.linearClamp, this.atmosphere.transmittance);
    this.shadows = new PhotoShadows(device, host.layouts.node, host.nodePool, tier.maps);

    const F = GPUShaderStage.FRAGMENT;
    const pointModule = device.createShaderModule({ code: POINT_SHADER });
    const gbufferTargets: GPUColorTargetState[] = [{ format: 'rgba8unorm' }, { format: 'r8unorm' }];
    const reversedZ: GPUDepthStencilState = { format: GBUFFER_DEPTH_FORMAT, depthCompare: 'greater', depthWriteEnabled: true };
    const pointDescriptor: GPURenderPipelineDescriptor = {
      layout: device.createPipelineLayout({ bindGroupLayouts: [host.layouts.scene, host.layouts.pointParams, host.layouts.node] }),
      vertex: {
        module: pointModule,
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: LOD_POINT_STRIDE, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
          { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' }] },
        ],
      },
      fragment: { module: pointModule, entryPoint: 'fs_photo', targets: gbufferTargets },
      primitive: { topology: 'triangle-strip' },
      depthStencil: reversedZ,
    };
    this.gbufferPoint = device.createRenderPipeline(pointDescriptor);
    this.gbufferSquare = device.createRenderPipeline({
      ...pointDescriptor,
      fragment: { module: pointModule, entryPoint: 'fs_photo_square', targets: gbufferTargets },
    });
    const terrainModule = device.createShaderModule({ code: TERRAIN_SHADER });
    this.gbufferTerrain = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [host.layouts.scene, host.layouts.terrainLod] }),
      vertex: { module: terrainModule, entryPoint: 'terrain_lod_vs', buffers: TERRAIN_VERTEX_BUFFERS },
      fragment: { module: terrainModule, entryPoint: 'terrain_photo_fs', targets: gbufferTargets },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { ...reversedZ, depthBiasSlopeScale: -4 },
    });
    const overlayDepth: GPUDepthStencilState = { format: GBUFFER_DEPTH_FORMAT, depthCompare: 'greater-equal', depthWriteEnabled: false };
    const sceneOnly = device.createPipelineLayout({ bindGroupLayouts: [host.layouts.scene] });
    const routeModule = device.createShaderModule({ code: ROUTE_SHADER });
    this.overlayRoute = device.createRenderPipeline({
      layout: sceneOnly,
      vertex: {
        module: routeModule,
        entryPoint: 'route_vs',
        buffers: [
          { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' }] },
        ],
      },
      fragment: { module: routeModule, entryPoint: 'route_fs', targets: [{ format: 'rgba8unorm', blend: ALPHA_BLEND }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: overlayDepth,
    });
    this.overlayPreview = device.createRenderPipeline({
      layout: sceneOnly,
      vertex: { module: terrainModule, entryPoint: 'terrain_vs', buffers: TERRAIN_VERTEX_BUFFERS },
      fragment: { module: terrainModule, entryPoint: 'terrain_fs', targets: [{ format: 'rgba8unorm', blend: ALPHA_BLEND }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: overlayDepth,
    });

    this.lightingLayout = bindGroupLayout(device, F, [
      { uniform: true }, { storage: 'read-only-storage' }, { texture: 'float' }, { texture: 'float' }, { texture: 'depth' },
      { texture: 'depth' }, { texture: 'depth' }, { sampler: 'comparison' }, { texture: 'unfilterable-float' },
      { texture: 'float' }, { sampler: 'filtering' }, { texture: 'unfilterable-float' }, { texture: 'float' },
    ]);
    const lightingModule = device.createShaderModule({ code: LIGHTING_SHADER });
    this.lightingPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.lightingLayout] }),
      vertex: { module: lightingModule, entryPoint: 'fullscreen_vs' },
      fragment: {
        module: lightingModule,
        entryPoint: 'lighting_fs',
        targets: [{ format: HDR_FORMAT, blend: ACCUMULATE_BLEND }, { format: HDR_FORMAT, blend: ACCUMULATE_BLEND }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.compositeLayout = bindGroupLayout(device, F, [
      { uniform: true }, { storage: 'read-only-storage' }, { texture: 'float' }, { texture: 'float' }, { texture: 'depth' },
      { texture: 'float' }, { texture: 'float', dimension: '3d' }, { texture: 'float' }, { sampler: 'filtering' },
      { texture: 'float' }, { texture: 'unfilterable-float' }, { texture: 'float', dimension: '3d' }, { texture: 'float' },
      { texture: 'float' }, { texture: 'float' },
    ]);
    const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });
    this.compositePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: compositeModule, entryPoint: 'fullscreen_vs' },
      fragment: { module: compositeModule, entryPoint: 'composite_fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    this.bloomLayout = bindGroupLayout(device, F, [{ texture: 'float' }, { sampler: 'filtering' }]);
    const bloomModule = device.createShaderModule({ code: BLOOM_SHADER });
    const bloomPipeline = (entryPoint: string, blend?: GPUBlendState) => device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bloomLayout] }),
      vertex: { module: bloomModule, entryPoint: 'fullscreen_vs' },
      fragment: { module: bloomModule, entryPoint, targets: [{ format: HDR_FORMAT, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bloomDownFirst = bloomPipeline('bloom_down_first_fs');
    this.bloomDown = bloomPipeline('bloom_down_fs');
    this.bloomUp = bloomPipeline('bloom_up_fs', ADD_BLEND);

    this.finalLayout = bindGroupLayout(device, F, [
      { uniform: true }, { storage: 'read-only-storage' }, { texture: 'float' }, { texture: 'float' }, { texture: 'float' }, { sampler: 'filtering' },
    ]);
    const finalModule = device.createShaderModule({ code: FINAL_SHADER });
    this.finalPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalLayout] }),
      vertex: { module: finalModule, entryPoint: 'fullscreen_vs' },
      fragment: { module: finalModule, entryPoint: 'final_fs', targets: [{ format: host.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  destroy(): void {
    this.uniforms.destroy();
    this.lighting.destroy();
    this.atmosphere.destroy();
    this.clouds.destroy();
    this.shadows.destroy();
  }
}

export class PhotoRenderer implements PhotoModeRenderer {
  private readonly host: PhotoRendererHost;
  private resources: PhotoResources | null = null;
  private fullTargets: PhotoTargets | null = null;
  private motionTargets: PhotoTargets | null = null;
  private lastTargets: PhotoTargets | null = null;
  private activeFlag = false;

  private settings: PhotoRenderSettings | null = null;
  private scene: PhotoSceneInfo | null = null;
  private casters: PhotoCasterSource | null = null;
  private focusCentre: Vec3 = [0, 0, 0];
  private focusHalfSize = 150;

  private readonly uniformData = new Float32Array(PHOTO_UNIFORM_FLOATS);
  private readonly invDraw = new Float32Array(16);
  private readonly invView = new Float32Array(16);
  private readonly prevViewProj = new Float32Array(16);
  private readonly lastViewProj = new Float32Array(16);
  private readonly identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  private hasPrevView = false;

  private frameIndex = 0;
  private cloudHistoryValid = false;
  /** Still accumulation of the clouds: index of this frame's pass, −1 while moving. */
  private stillIndex = -1;
  /** The accumulation holds an image of the current view (pixels not traced yet may show it). */
  private stillViewValid = false;
  /** Settings or tables changed: the accumulation starts over. */
  private stillRestart = true;
  private lastCloudVersion = -1;
  private shadowArea: CloudShadowArea = { centreX: 0, centreZ: 0, halfSizeM: 2000, subjectRadiusM: 0 };
  private mediaDirty = true;
  private skyDirty = true;
  private lastSkyKey = '';
  private lastMediaKey = '';
  private lastSunKey = '';
  private lastLayerKey = '';

  private shadowVersion = -1;
  private dsmVersion = -1;
  private shadowSunDirty = true;
  private cascade1Centre: Vec3 = [0, 0, 0];
  private cascade1HalfSize = 0;
  private dsmFinished = false;

  private captureRequest: CaptureRequest | null = null;
  private readonly debugView = readDebugView();
  private debugReadback: GPUBuffer | null = null;
  private pendingReadback: CaptureRequest | null = null;

  constructor(host: PhotoRendererHost) {
    this.host = host;
  }

  get active(): boolean {
    return this.activeFlag;
  }

  setActive(active: boolean): void {
    if (active === this.activeFlag) return;
    this.activeFlag = active;
    if (active) {
      this.resources = new PhotoResources(this.host);
      this.resetState();
    } else {
      this.destroyResources();
      this.captureRequest?.reject(new Error('Photo mode closed'));
      this.captureRequest = null;
    }
  }

  setSettings(settings: PhotoRenderSettings): void {
    this.settings = settings;
  }

  setScene(scene: PhotoSceneInfo): void {
    this.scene = scene;
    this.shadowVersion = -1;
    this.dsmVersion = -1;
  }

  setCasterSource(source: PhotoCasterSource | null): void {
    this.casters = source;
  }

  setFocus(centre: [number, number, number], halfSizeM: number): void {
    this.focusCentre = [centre[0], centre[1], centre[2]];
    this.focusHalfSize = Math.max(30, Math.min(320, halfSizeM));
  }

  /** Frames of the still accumulation of the clouds (pixels per block × samples). */
  private get stillFrames(): number {
    const tier = TIER_SETTINGS[this.host.tier];
    return tier.stillInterleave * tier.stillSamples;
  }

  needsFrames(): boolean {
    if (!this.activeFlag || !this.resources) return false;
    if (this.captureRequest || this.pendingReadback) return true;
    const clouds = this.settings?.cloud;
    if (!clouds || !hasClouds(clouds)) return false;
    return this.resources.clouds.building || this.stillIndex < this.stillFrames - 1;
  }

  cloudProgress(): { done: number; total: number } {
    const total = this.stillFrames;
    const clouds = this.settings?.cloud;
    if (!clouds || !hasClouds(clouds)) return { done: total, total };
    return { done: Math.max(0, Math.min(total, this.stillIndex + 1)), total };
  }

  getCloudMs(): number {
    return this.host.timer?.getCloudMs() ?? 0;
  }

  capture(): Promise<Blob> {
    if (!this.activeFlag) return Promise.reject(new Error('Photo mode is off'));
    this.captureRequest?.reject(new Error('Replaced by a newer capture'));
    return new Promise<Blob>((resolve, reject) => {
      this.captureRequest = { resolve, reject };
    });
  }

  private resetState(): void {
    this.frameIndex = 0;
    this.cloudHistoryValid = false;
    this.stillIndex = -1;
    this.stillViewValid = false;
    this.stillRestart = true;
    this.lastCloudVersion = -1;
    this.mediaDirty = true;
    this.skyDirty = true;
    this.lastMediaKey = '';
    this.lastSkyKey = '';
    this.lastSunKey = '';
    this.lastLayerKey = '';
    this.shadowVersion = -1;
    this.dsmVersion = -1;
    this.shadowSunDirty = true;
    this.cascade1HalfSize = 0;
    this.dsmFinished = false;
    this.hasPrevView = false;
  }

  private destroyResources(): void {
    this.destroyTargets(this.fullTargets);
    this.destroyTargets(this.motionTargets);
    this.fullTargets = null;
    this.motionTargets = null;
    this.lastTargets = null;
    this.resources?.destroy();
    this.resources = null;
  }

  private createTargets(width: number, height: number): PhotoTargets {
    const { device } = this.host;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const tex = (format: GPUTextureFormat, w = width, h = height) => device.createTexture({ size: [w, h], format, usage });
    const bloom: GPUTexture[] = [];
    let bw = width;
    let bh = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
      bloom.push(tex(HDR_FORMAT, bw, bh));
    }
    const depth = tex(GBUFFER_DEPTH_FORMAT);
    return {
      width,
      height,
      albedo: tex('rgba8unorm'),
      material: tex('r8unorm'),
      overlay: tex('rgba8unorm'),
      depth,
      direct: tex(HDR_FORMAT),
      ambient: tex(HDR_FORMAT),
      hdr: tex(HDR_FORMAT),
      bloom,
      depthView: depth.createView(),
      hasOverlay: true,
      lightingGroup: null,
      lightingKey: [],
      compositeGroups: new Map(),
      finalGroup: null,
      bloomDownGroups: [],
      bloomUpGroups: [],
    };
  }

  private destroyTargets(targets: PhotoTargets | null): void {
    if (!targets) return;
    for (const t of [targets.albedo, targets.material, targets.overlay, targets.depth, targets.direct, targets.ambient, targets.hdr, ...targets.bloom]) {
      t.destroy();
    }
  }

  private ensureTargets(frame: PhotoFrame): void {
    const fw = Math.max(1, frame.canvasWidth);
    const fh = Math.max(1, frame.canvasHeight);
    if (!this.fullTargets || this.fullTargets.width !== fw || this.fullTargets.height !== fh) {
      this.destroyTargets(this.fullTargets);
      this.fullTargets = this.createTargets(fw, fh);
      this.lastTargets = null;
    }
    if (frame.motionScale < 1) {
      const mw = Math.max(1, Math.round(fw * frame.motionScale));
      const mh = Math.max(1, Math.round(fh * frame.motionScale));
      if (!this.motionTargets || this.motionTargets.width !== mw || this.motionTargets.height !== mh) {
        this.destroyTargets(this.motionTargets);
        this.motionTargets = this.createTargets(mw, mh);
      }
    }
    if (this.resources!.clouds.resize(fw, fh)) {
      this.cloudHistoryValid = false;
      this.stillViewValid = false;
      this.stillIndex = -1;
      // The composite groups hold the cloud buffers.
      for (const targets of [this.fullTargets, this.motionTargets]) targets?.compositeGroups.clear();
    }
  }

  /** Reacts to settings changes: which tables and histories are stale. */
  private applySettings(settings: PhotoRenderSettings, scene: PhotoSceneInfo, camAltitudeM: number): void {
    const r = this.resources!;
    const cloud = settings.cloud;
    const mediaKey = `${settings.haze.toFixed(3)}|${scene.groundAlbedo.toFixed(3)}`;
    if (mediaKey !== this.lastMediaKey) {
      this.lastMediaKey = mediaKey;
      this.mediaDirty = true;
    }
    const sun = settings.sunDirection;
    const sunKey = sun.map((v) => v.toFixed(5)).join('|');
    if (sunKey !== this.lastSunKey) {
      this.lastSunKey = sunKey;
      this.skyDirty = true;
      this.shadowSunDirty = true;
      r.clouds.invalidateLight();
      this.cloudHistoryValid = false;
      this.stillRestart = true;
    }
    const skyKey = `${Math.round(camAltitudeM / 25)}`;
    if (skyKey !== this.lastSkyKey) {
      this.lastSkyKey = skyKey;
      this.skyDirty = true;
    }
    const layerKey = `${cloud.baseAltitudeM}|${cloud.topAltitudeM}|${cloud.extinction}|${cloud.absorption}`;
    if (layerKey !== this.lastLayerKey) {
      this.lastLayerKey = layerKey;
      r.clouds.invalidateLight();
      this.cloudHistoryValid = false;
      this.stillRestart = true;
    }
    this.shadowArea = cloudShadowArea(settings.sunDirection, scene, cloud.baseAltitudeM);
    r.clouds.setWeather({
      coverage: cloud.coverage,
      type: cloud.type,
      seed: cloud.seed,
      cellSizeM: cloud.cellSizeM,
      anvil: cloud.anvil,
      domainHalfM: CLOUD_DOMAIN_HALF_M,
      fullRadiusM: CLOUD_FULL_RADIUS_M,
      clearingX: this.shadowArea.centreX,
      clearingZ: this.shadowArea.centreZ,
      clearingRadiusM: this.shadowArea.subjectRadiusM,
      ...sunCorridor(settings.sunDirection),
      thicknessM: cloud.topAltitudeM - cloud.baseAltitudeM,
    });
    r.clouds.setShadowArea(this.shadowArea.centreX, this.shadowArea.centreZ, this.shadowArea.halfSizeM);
    // A rebuild completed: what was accumulated shows the old clouds.
    if (r.clouds.version !== this.lastCloudVersion) {
      this.lastCloudVersion = r.clouds.version;
      this.stillRestart = true;
    }
  }

  /** Redraws the shadow maps / surface model that are stale (never while the camera moves, except for a new sun). */
  private updateShadows(frame: PhotoFrame, settings: PhotoRenderSettings, scene: PhotoSceneInfo): void {
    const r = this.resources!;
    const source = this.casters;
    if (!source) return;
    const tier = TIER_SETTINGS[this.host.tier];
    const version = source.version();
    const still = !frame.motion;
    const casterChange = version !== this.shadowVersion && (still || this.shadowVersion < 0);
    const sun = settings.sunDirection;
    const sunUp = sun[1] > -0.02;
    const options = {
      source,
      maxPoints: tier.casters,
      pointSizeM: frame.pointSizeM,
      terrain: frame.terrainVisible ? frame.terrain : null,
      filterEnabled: frame.pointFilter.enabled,
      filterMask: frame.pointFilter.mask,
    };
    const bounds: AABB = scene.bounds;
    const toLight: Vec3 = [sun[0], Math.max(sun[1], 0.02), sun[2]];
    if (sunUp && (this.shadowSunDirty || casterChange)) {
      const proj = fitLightToBox(toLight, bounds, r.shadows.maps[SHADOW_MAP.cascade0]!.width);
      r.shadows.draw(frame.encoder, SHADOW_MAP.cascade0, toLight, proj, options);
    }
    const c1 = this.cascade1Centre;
    const offset = Math.hypot(this.focusCentre[0] - c1[0], this.focusCentre[2] - c1[2]);
    const ratio = this.cascade1HalfSize > 0 ? this.focusHalfSize / this.cascade1HalfSize : 0;
    const refit = this.cascade1HalfSize === 0 || offset > this.cascade1HalfSize * 0.45 || ratio < 0.65 || ratio > 1.5;
    if (sunUp && (this.shadowSunDirty || casterChange || (still && refit))) {
      const centre = refit || this.cascade1HalfSize === 0 ? this.focusCentre : this.cascade1Centre;
      const halfSize = refit || this.cascade1HalfSize === 0 ? this.focusHalfSize : this.cascade1HalfSize;
      const proj = fitLightToSquare(toLight, centre, halfSize, bounds, r.shadows.maps[SHADOW_MAP.cascade1]!.width);
      r.shadows.draw(frame.encoder, SHADOW_MAP.cascade1, toLight, proj, options);
      this.cascade1Centre = [centre[0], centre[1], centre[2]];
      this.cascade1HalfSize = halfSize;
    }
    if (version !== this.dsmVersion && (still || this.dsmVersion < 0)) {
      const proj = fitLightToBox([0, 1, 0], bounds, r.shadows.maps[SHADOW_MAP.dsm]!.width);
      r.shadows.draw(frame.encoder, SHADOW_MAP.dsm, [0, 1, 0], proj, options);
      r.shadows.finishDsm(frame.encoder, frame.heightTexture, frame.heightmap);
      this.dsmVersion = version;
      this.dsmFinished = true;
    }
    if (sunUp) this.shadowSunDirty = false;
    if (casterChange) this.shadowVersion = version;
    if (!sunUp) {
      r.shadows.states[SHADOW_MAP.cascade0]!.valid = false;
      r.shadows.states[SHADOW_MAP.cascade1]!.valid = false;
    }
  }

  private buildUniforms(
    frame: PhotoFrame,
    settings: PhotoRenderSettings,
    scene: PhotoSceneInfo,
    targets: PhotoTargets,
    cloudsOn: boolean,
    temporal: [number, number, number, number],
    cloudSize: [number, number, number, number],
    cloudStill: [number, number, number, number],
  ): void {
    const r = this.resources!;
    const shadows = r.shadows;
    const c0 = shadows.states[SHADOW_MAP.cascade0]!;
    const c1 = shadows.states[SHADOW_MAP.cascade1]!;
    const dsm = shadows.states[SHADOW_MAP.dsm]!;
    const cloud = settings.cloud;
    const cam = frame.camPos;
    const camAlt = scene.centerAltitudeM + cam[1]!;
    const phase = mieFitForDiameter(CLOUD_DROPLET_DIAMETER_UM);
    const tier = TIER_SETTINGS[this.host.tier];
    // Hillaire's Mie density is a very clean sky (aerosol optical depth ≈ 0.005); real air
    // is 0.03–0.2: haze 0 → 0.01, 25 → ≈ 0.035, 100 → ≈ 0.2.
    const mieScale = 2 + 38 * Math.pow(Math.max(0, Math.min(1, settings.haze)), 1.5);
    const values: PhotoUniformValues = {
      invDrawViewProj: this.invDraw,
      viewProj: frame.viewProj,
      prevViewProj: this.hasPrevView ? this.prevViewProj : frame.viewProj,
      invViewProj: this.invView,
      shadow0: c0.matrix,
      shadow1: c1.matrix,
      dsm: dsm.valid ? dsm.matrix : this.identity,
      cameraPos: [cam[0]!, cam[1]!, cam[2]!, camAlt],
      sunDir: [settings.sunDirection[0], settings.sunDirection[1], settings.sunDirection[2], 1],
      scene: [scene.centerAltitudeM, scene.minAltitudeM, scene.groundAlbedo, 0],
      cloudLayer: [cloud.baseAltitudeM, cloud.topAltitudeM, cloud.coverage, cloud.type],
      cloudParams: [cloud.extinction, cloud.absorption, CLOUD_DOMAIN_HALF_M, cloud.seed],
      cloudShadow: [this.shadowArea.centreX, this.shadowArea.centreZ, this.shadowArea.halfSizeM, r.clouds.ready ? 1 : 0],
      phase: [phase.gHG, phase.gD, phase.alpha, phase.wD],
      shadowInfo: [c0.texelM, c1.texelM, c0.depthRangeM, c1.depthRangeM],
      flags: [c1.valid ? 1 : 0, c0.valid ? 1 : 0, dsm.valid && this.dsmFinished ? 1 : 0, SCREEN_OCCLUSION_STRENGTH],
      dtm: [frame.heightmap[0], frame.heightmap[1], frame.heightmap[2], frame.heightmap[3]],
      frame: [this.frameIndex, frame.accumulate, 0, 0],
      targetSize: [targets.width, targets.height, frame.canvasWidth, frame.canvasHeight],
      cloudSize,
      exposure: [Math.pow(2, settings.exposureEv), settings.haze, BLOOM_STRENGTH, 0],
      atmosphere: [mieScale, scene.groundAlbedo, Math.max(0.01, camAlt / 1000), cloudsOn ? 1 : 0],
      dsmInfo: [0, dsm.depthRangeM, dsm.texelM, tier.cloudSteps],
      quality: [frame.motion ? 1.35 : 1, AERIAL_PERSPECTIVE_MAX_KM, SUN_TAN_RADIUS, this.debugView],
      cloudTemporal: temporal,
      cloudStill,
      highClouds0: highUniform(cloud.high[0]),
      highClouds1: highUniform(cloud.high[1]),
    };
    packPhotoUniforms(this.uniformData, values);
    this.host.device.queue.writeBuffer(r.uniforms, 0, this.uniformData);
  }

  /** Encodes the photo frame; returns the draw calls issued. */
  render(frame: PhotoFrame): number {
    const settings = this.settings;
    const scene = this.scene;
    if (!this.activeFlag || !this.resources || !settings || !scene) return 0;
    const r = this.resources;
    this.ensureTargets(frame);
    const reuse = frame.reuseScene && this.lastTargets !== null;
    const targets = reuse
      ? this.lastTargets!
      : (frame.motion && frame.motionScale < 1 && this.motionTargets ? this.motionTargets : this.fullTargets!);
    let draws = 0;

    // Camera motion.
    const moved = !this.hasPrevView || !matricesEqual(frame.viewProj, this.lastViewProj);
    if (this.hasPrevView) this.prevViewProj.set(this.lastViewProj);
    this.lastViewProj.set(frame.viewProj);
    if (!reuse) invertMat4(this.invDraw, frame.drawViewProj);
    invertMat4(this.invView, frame.viewProj);

    this.applySettings(settings, scene, scene.centerAltitudeM + frame.camPos[1]!);
    const cloudsWanted = hasClouds(settings.cloud);
    const cloudsOn = cloudsWanted && r.clouds.ready;

    // Clouds: while the view moves, one pixel per 2×2 block of the
    // half-resolution buffer, reprojected; once it stops (at full
    // resolution), every pixel traced in turn and averaged in place until
    // the sample count is reached.
    const tier = TIER_SETTINGS[this.host.tier];
    const stillClouds = cloudsOn && !moved && targets === this.fullTargets;
    if (moved) this.stillViewValid = false;
    const previousIndex = this.stillIndex;
    if (!stillClouds) {
      this.stillIndex = -1;
    } else if (this.stillRestart || r.clouds.building || previousIndex < 0) {
      this.stillIndex = 0;
      this.stillRestart = false;
    } else if (previousIndex < this.stillFrames - 1) {
      this.stillIndex = previousIndex + 1;
    }
    // The last pass is not repeated once the sample count is reached.
    const tracesStill = stillClouds && (this.stillIndex === 0 || this.stillIndex !== previousIndex);
    const interleave = tier.stillInterleave;
    const sampleIndex = this.stillIndex >= 0 ? Math.floor(this.stillIndex / interleave) : 0;
    const cloudStill: [number, number, number, number] = [interleave, this.stillIndex, this.stillViewValid ? 1 : 0, sampleIndex];
    const fullTrace = !this.cloudHistoryValid;
    const weight = fullTrace || this.debugView === 8 ? 1 : CLOUD_MOVING_WEIGHT;
    const [cw, ch] = r.clouds.size;
    const temporal: [number, number, number, number] = [weight, 1, 0, this.cloudHistoryValid ? 1 : 0];
    const cloudSize: [number, number, number, number] = [cw, ch, fullTrace ? 1 : 0, this.frameIndex % 4];

    // Shadow maps first: the uniforms carry their matrices.
    if (!reuse) this.updateShadows(frame, settings, scene);
    this.buildUniforms(frame, settings, scene, targets, cloudsOn, temporal, cloudSize, cloudStill);

    const encoder = frame.encoder;
    r.atmosphere.encode(encoder, { media: this.mediaDirty, sky: this.skyDirty, view: moved || this.mediaDirty || this.skyDirty });
    this.mediaDirty = false;
    this.skyDirty = false;
    if (cloudsWanted) r.clouds.encodeBuild(encoder);

    const timer = this.host.timer;
    if (!reuse) {
      frame.writePointParams(targets.width, targets.height, targets.width / frame.canvasWidth);
      draws += this.encodeGBuffer(frame, targets, timer);
      draws += this.encodeOverlays(frame, targets);
    }
    const photoBegin = frame.timed ? timer?.passTimestamps(TIMED_PASS.photo, 'begin') : undefined;
    if (!reuse) {
      this.encodeLighting(frame, targets, photoBegin);
      draws += 1;
    }
    const cloudTimestamps = {
      begin: frame.timed ? timer?.passTimestamps(TIMED_PASS.clouds, 'begin') : undefined,
      end: frame.timed ? timer?.passTimestamps(TIMED_PASS.clouds, 'end') : undefined,
    };
    if (cloudsOn && !stillClouds) {
      r.clouds.encodeMoving(encoder, targets.depthView, fullTrace, cloudTimestamps);
      this.cloudHistoryValid = true;
    } else if (tracesStill) {
      r.clouds.encodeStill(encoder, targets.depthView, interleave, 1 / (sampleIndex + 1), cloudTimestamps);
      this.stillViewValid = true;
    }
    this.encodeComposite(encoder, targets, reuse ? photoBegin : undefined);
    this.encodeBloom(encoder, targets);
    this.encodeFinal(encoder, targets, frame.canvasView, frame.timed ? timer?.passTimestamps(TIMED_PASS.photo, 'end') : undefined);
    draws += 3 + BLOOM_LEVELS * 2;
    if (this.captureRequest) this.encodeCapture(encoder, targets, frame.canvasWidth, frame.canvasHeight);
    if (this.debugView > 0 && this.frameIndex === 60) {
      this.debugReadback = this.host.device.createBuffer({ size: PHOTO_LIGHTING_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyBufferToBuffer(r.lighting, 0, this.debugReadback, 0, PHOTO_LIGHTING_BYTES);
    }

    this.lastTargets = targets;
    this.hasPrevView = true;
    this.frameIndex++;
    return draws;
  }

  /** Call after the frame's submit: maps a pending capture. */
  afterSubmit(): void {
    const debug = this.debugReadback;
    if (debug) {
      this.debugReadback = null;
      void debug.mapAsync(GPUMapMode.READ).then(() => {
        const v = Array.from(new Float32Array(debug.getMappedRange()), (x) => Number(x.toPrecision(4)));
        console.warn(`[Photo debug] sunScene=${v.slice(0, 3)} sunClouds=${v.slice(4, 7)} skyUp=${v.slice(8, 11)} groundUp=${v.slice(12, 15)} exposure=${v.slice(16, 18)} skySide=${v.slice(20, 23)} shadows=${JSON.stringify(this.resources?.shadows.casterPoints)} sun=${this.settings?.sunDirection.map((x) => x.toFixed(3))}`);
        debug.unmap();
        debug.destroy();
      });
    }
    const request = this.pendingReadback;
    if (!request || !request.buffer) return;
    this.pendingReadback = null;
    const { buffer: readback, bytesPerRow = 0, width = 0, height = 0, texture } = request;
    readback.mapAsync(GPUMapMode.READ)
      .then(async () => {
        const mapped = new Uint8Array(readback.getMappedRange());
        const pixels = new Uint8ClampedArray(width * height * 4);
        const bgra = this.host.canvasFormat === 'bgra8unorm';
        for (let y = 0; y < height; y++) {
          const src = y * bytesPerRow;
          const dst = y * width * 4;
          for (let x = 0; x < width; x++) {
            const s = src + x * 4;
            const d = dst + x * 4;
            pixels[d] = mapped[bgra ? s + 2 : s]!;
            pixels[d + 1] = mapped[s + 1]!;
            pixels[d + 2] = mapped[bgra ? s : s + 2]!;
            pixels[d + 3] = 255;
          }
        }
        readback.unmap();
        readback.destroy();
        texture?.destroy();
        request.resolve(await encodePng(pixels, width, height));
      })
      .catch((error: unknown) => {
        readback.destroy();
        texture?.destroy();
        request.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private encodeGBuffer(frame: PhotoFrame, targets: PhotoTargets, timer: GpuFrameTimer | null): number {
    const r = this.resources!;
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        { view: targets.albedo.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: targets.material.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: targets.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: frame.timed ? timer?.passTimestamps(TIMED_PASS.scene) : undefined,
    });
    pass.setBindGroup(0, frame.sceneBindGroup);
    pass.setPipeline(frame.motion && frame.squares ? r.gbufferSquare : r.gbufferPoint);
    pass.setBindGroup(1, frame.pointParamsBindGroup);
    let draws = this.host.nodePool.draw(pass, frame.nodes);
    if (frame.terrain && frame.terrainVisible) {
      const focalPx = Math.abs(frame.viewProj[5] ?? 1) * frame.canvasHeight * 0.5;
      draws += frame.terrain.draw(pass, r.gbufferTerrain, frame.viewProj, frame.camPos, focalPx);
    }
    pass.end();
    return draws;
  }

  private encodeOverlays(frame: PhotoFrame, targets: PhotoTargets): number {
    const r = this.resources!;
    const { preview, route, analysis } = frame.overlays;
    const any = (preview && preview.count > 0) || (route && route.count > 0) || (analysis && analysis.count > 0);
    if (!any && !targets.hasOverlay) return 0;
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [{ view: targets.overlay.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: targets.depthView, depthReadOnly: true },
    });
    let draws = 0;
    pass.setBindGroup(0, frame.sceneBindGroup);
    const drawMesh = (mesh: MeshBuffers | null, pipeline: GPURenderPipeline) => {
      if (!mesh || mesh.count <= 0) return;
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, mesh.vertBuf);
      pass.setVertexBuffer(1, mesh.colBuf);
      pass.setIndexBuffer(mesh.idxBuf, 'uint32');
      pass.drawIndexed(mesh.count);
      draws++;
    };
    drawMesh(preview, r.overlayPreview);
    drawMesh(analysis, r.overlayRoute);
    drawMesh(route, r.overlayRoute);
    pass.end();
    targets.hasOverlay = Boolean(any);
    return draws;
  }

  private encodeLighting(frame: PhotoFrame, targets: PhotoTargets, timestamps: GPURenderPassTimestampWrites | undefined): void {
    const r = this.resources!;
    const shadows = r.shadows;
    const key = [frame.heightTexture];
    if (!targets.lightingGroup || !sameKey(key, targets.lightingKey)) {
      targets.lightingKey = key;
      targets.lightingGroup = bindGroup(this.host.device, r.lightingLayout, [
        buffer(r.uniforms), buffer(r.lighting), targets.albedo.createView(), targets.material.createView(), targets.depthView,
        shadows.maps[SHADOW_MAP.cascade0]!.createView(), shadows.maps[SHADOW_MAP.cascade1]!.createView(), r.shadowCmp,
        shadows.dsmHeight.createView(), shadows.dsmInfo.createView(), r.linearClamp, frame.heightTexture.createView(),
        r.atmosphere.transmittance.createView(),
      ]);
    }
    const accumulating = frame.accumulate >= 0;
    const loadOp: GPULoadOp = accumulating && frame.accumulate > 0 ? 'load' : 'clear';
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        { view: targets.direct.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp, storeOp: 'store' },
        { view: targets.ambient.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp, storeOp: 'store' },
      ],
      timestampWrites: timestamps,
    });
    const weight = accumulating ? 1 / (frame.accumulate + 1) : 1;
    pass.setPipeline(r.lightingPipeline);
    pass.setBindGroup(0, targets.lightingGroup);
    pass.setBlendConstant({ r: weight, g: weight, b: weight, a: weight });
    pass.draw(3);
    pass.end();
  }

  private encodeComposite(encoder: GPUCommandEncoder, targets: PhotoTargets, timestamps: GPURenderPassTimestampWrites | undefined): void {
    const r = this.resources!;
    const cloudOut = r.clouds.output();
    const still = r.clouds.stillTextures();
    if (!cloudOut || !still) return;
    let group = targets.compositeGroups.get(cloudOut.color);
    if (!group) {
      if (targets.compositeGroups.size >= 2) targets.compositeGroups.clear();
      group = bindGroup(this.host.device, r.compositeLayout, [
        buffer(r.uniforms), buffer(r.lighting), targets.direct.createView(), targets.ambient.createView(), targets.depthView,
        r.atmosphere.skyView.createView(), r.atmosphere.aerialPerspective.createView({ dimension: '3d' }),
        r.atmosphere.transmittance.createView(), r.linearClamp, cloudOut.color.createView(), cloudOut.depth.createView(),
        r.clouds.lightVolume.createView({ dimension: '3d' }), still.color.createView(), still.dist.createView(),
        r.clouds.shadowMap.createView(),
      ]);
      targets.compositeGroups.set(cloudOut.color, group);
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targets.hdr.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: timestamps,
    });
    pass.setPipeline(r.compositePipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  private encodeBloom(encoder: GPUCommandEncoder, targets: PhotoTargets): void {
    const r = this.resources!;
    const { device } = this.host;
    if (targets.bloomDownGroups.length === 0) {
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const source = i === 0 ? targets.hdr : targets.bloom[i - 1]!;
        targets.bloomDownGroups.push(bindGroup(device, r.bloomLayout, [source.createView(), r.linearClamp]));
      }
      for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
        targets.bloomUpGroups.push(bindGroup(device, r.bloomLayout, [targets.bloom[i + 1]!.createView(), r.linearClamp]));
      }
    }
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: targets.bloom[i]!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(i === 0 ? r.bloomDownFirst : r.bloomDown);
      pass.setBindGroup(0, targets.bloomDownGroups[i]!);
      pass.draw(3);
      pass.end();
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: targets.bloom[i]!.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(r.bloomUp);
      pass.setBindGroup(0, targets.bloomUpGroups[i]!);
      pass.draw(3);
      pass.end();
    }
  }

  private finalGroup(targets: PhotoTargets): GPUBindGroup {
    const r = this.resources!;
    if (!targets.finalGroup) {
      targets.finalGroup = bindGroup(this.host.device, r.finalLayout, [
        buffer(r.uniforms), buffer(r.lighting), targets.hdr.createView(), targets.bloom[0]!.createView(),
        targets.overlay.createView(), r.linearClamp,
      ]);
    }
    return targets.finalGroup;
  }

  private encodeFinal(encoder: GPUCommandEncoder, targets: PhotoTargets, view: GPUTextureView, timestamps: GPURenderPassTimestampWrites | undefined): void {
    const r = this.resources!;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: timestamps,
    });
    pass.setPipeline(r.finalPipeline);
    pass.setBindGroup(0, this.finalGroup(targets));
    pass.draw(3);
    pass.end();
  }

  /** Draws the final image once more into a copyable texture and reads it back after the submit. */
  private encodeCapture(encoder: GPUCommandEncoder, targets: PhotoTargets, width: number, height: number): void {
    const request = this.captureRequest!;
    this.captureRequest = null;
    const { device } = this.host;
    const texture = device.createTexture({
      size: [width, height],
      format: this.host.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.encodeFinal(encoder, targets, texture.createView(), undefined);
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [width, height]);
    request.texture = texture;
    request.buffer = readback;
    request.bytesPerRow = bytesPerRow;
    request.width = width;
    request.height = height;
    this.pendingReadback = request;
  }

  destroy(): void {
    this.setActive(false);
  }
}

async function encodePng(pixels: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const image = new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}
