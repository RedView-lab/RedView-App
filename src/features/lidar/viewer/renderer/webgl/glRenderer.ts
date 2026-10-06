// ============================================
// WebGL 2 point-cloud renderer
// ============================================
//
// The viewer's second backend, for browsers without WebGPU (Firefox and
// most Chrome builds on Linux in 2026, blocklisted drivers, older Safari):
// the same frame as `WebGpuLidarRenderer` — lazy per-node shading,
// instanced sprites with the adaptive size, chunked terrain LOD, overlays,
// route and analysis meshes, sun trajectory, EDL, reduced resolution while
// moving, MSAA with alpha-to-coverage on discrete GPUs and progressive
// anti-aliasing of still frames — so every viewer feature (tools,
// comments, route editing, snow) runs unchanged on top of it.
//
// Frame = shading pass (transform feedback, nodes that are new or stale)
// → scene pass into an offscreen target (MSAA renderbuffers resolved into
// textures when enabled) → one full-screen pass to the canvas: copy, EDL,
// upscale, or accumulation into an rgba16float running mean then present.
// Depth is conventional with a finite projection built from the camera's
// near/far (`setDepthRange`), see glShaders.ts.

import { translateAppText } from '@/shared/i18n/config';
import type { PlatformProfile } from '../../lod/types';
import type { SceneNode } from '../../lod/sceneLod';
import type { ViewerAltitudeState, ViewerSlopeState } from '../../rightPanel/types';
import { computePointFilterBitmasks, type ViewerPointFilterState } from '../../pointFilter';
import type { SolarRenderState } from '../../../viewer-webgl/sunlightController';
import { buildSlopeRampData } from '../../slope/slopeRamp';
import { buildAltitudeRampData, DEFAULT_MAX_ALTITUDE_M } from '../../altitude/altitudeRamp';
import { cameraPositionFromView, mat4MultiplyInto, vec3Of } from '../math';
import { flipRows, unitFloatsFromBytes } from '../gpuResources';
import { packSceneUniforms, SCENE_UNIFORM_FLOATS } from '../sceneUniforms';
import { POINT_PARAMS_FLOATS } from '../shaders';
import { TIMED_PASS } from '../gpuTimer';
import { fitProfileToMemory, resolveWebglPlatformInfo } from '../platform';
import type { HeightmapParams, SnowParams } from '../types';
import type { TerrainMeshData } from '../terrainLodCore';
import {
  COLOR_MODE_INDEX,
  type LidarRenderer,
  type PointColorMode,
  type RendererLostInfo,
  type RenderSceneOptions,
  type RenderStats,
} from '../sceneRenderer';
import {
  BLIT_FS,
  COLOR_MESH_FS,
  COLOR_MESH_VS,
  EDL_ACCUMULATE_FS,
  EDL_FS,
  FULLSCREEN_VS,
  PASS_TEXTURE_UNITS,
  POINT_FS,
  POINT_SQUARE_FS,
  POINT_VS,
  PRESENT_FS,
  SCENE_TEXTURE_UNITS,
  SHADING_FS,
  SHADING_VARYINGS,
  SHADING_VS,
  SUN_DISC_FS,
  SUN_DISC_VS,
  TERRAIN_FS,
  TERRAIN_VS,
  UBO_BINDING,
} from './glShaders';
import {
  createFloatTexture,
  createGlProgram,
  createRgbaTexture,
  createStaticBuffer,
  fitGridToTextureSize,
  setTextureFilter,
  writeRgbaTexture,
  type GlFilter,
} from './glUtils';
import { GlNodePool } from './glNodePool';
import { GlTerrainLod } from './glTerrainLod';
import {
  createGlAccumTarget,
  createGlSceneTargets,
  destroyGlAccumTarget,
  destroyGlSceneTargets,
  resolveGlSceneTargets,
  type GlAccumTarget,
  type GlSceneTargets,
} from './glTargets';
import { GlFrameTimer } from './glTimer';

/** Projected point diameter bounds (device pixels) for the metre-sized mode. */
const POINT_MIN_PX = 1.0;
const POINT_MAX_PX = 64;
/** Point diameter cap of the eye-level (first-person) view, device px. */
const EYE_LEVEL_POINT_MAX_PX = 14;
/** Adaptive size of the finest points on screen, per metre of their node's surface spacing. */
const ADAPTIVE_SPACING_FACTOR = 1.5;
/** Uniform slots of the node pool (one per resident LOD node). */
const NODE_POOL_CAPACITY = 16384;
/**
 * Slope-scaled depth offset of the terrain mesh (conventional depth:
 * positive pushes it back), the WebGPU `depthBiasSlopeScale` of −4 in
 * reversed-Z: the mesh only fills the holes between the ground returns.
 */
const TERRAIN_POLYGON_OFFSET_FACTOR = 4;
const SLOPE_RAMP_WIDTH = 256;
const ALTITUDE_RAMP_WIDTH = 512;

interface GlPrograms {
  point: WebGLProgram;
  pointSquare: WebGLProgram;
  shading: WebGLProgram;
  terrain: WebGLProgram;
  colorMesh: WebGLProgram;
  sunDisc: WebGLProgram;
  blit: WebGLProgram;
  edl: WebGLProgram;
  accumulate: WebGLProgram;
  present: WebGLProgram;
}

/** Indexed mesh with its vertex array (preview: position + normal; route/analysis: position). */
interface GlMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
}

interface SceneTextures {
  heightTex: WebGLTexture;
  snowTex: WebGLTexture;
  slopeTex: WebGLTexture;
  altitudeTex: WebGLTexture;
  shadowTex: WebGLTexture;
  sunlightMapTex: WebGLTexture;
}

/** Vendor/renderer strings: `RENDERER` first (Firefox exposes the real, sanitised name there), the debug extension otherwise. */
function readContextStrings(gl: WebGL2RenderingContext): { vendor: string; renderer: string } {
  const generic = /^(webkit|mozilla)( webgl)?$/i;
  let vendor = String(gl.getParameter(gl.VENDOR) ?? '');
  let renderer = String(gl.getParameter(gl.RENDERER) ?? '');
  if (generic.test(renderer.trim()) || !renderer) {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (debug) {
      vendor = String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? vendor);
      renderer = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? renderer);
    }
  }
  return { vendor, renderer };
}

export class WebGlLidarRenderer implements LidarRenderer {
  readonly backend = 'webgl' as const;
  readonly canvas: HTMLCanvasElement;
  readonly platform: PlatformProfile;
  /** GPU named by the context (logs, stats). */
  readonly rendererName: string;
  onDeviceLost: ((info: RendererLostInfo) => void) | null = null;

  motionScale = 1;
  motionSquares = true;
  centerAltitude = 0;
  pointSize = 0.3;
  pointSizeReference = 0;
  fixedPointPixels = 0;
  adaptivePointSize = true;
  terrainVisible = true;

  lastViewProj = new Float32Array(16);
  lastCamPos: Float32Array | [number, number, number] = new Float32Array(3);
  lastProjScaleY = 1;

  private readonly gl: WebGL2RenderingContext;
  private readonly programs: GlPrograms;
  private readonly pushBackLocation: WebGLUniformLocation | null;
  private readonly passLocations: Map<WebGLProgram, { edl: WebGLUniformLocation | null; depthRange: WebGLUniformLocation | null }>;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly sceneUbo: WebGLBuffer;
  private readonly pointParamsUbo: WebGLBuffer;
  private readonly timer: GlFrameTimer;
  private readonly textures: SceneTextures;
  private readonly maxTextureSize: number;
  /** Half-float targets are renderable: still frames get the progressive anti-aliasing. */
  private readonly canAccumulate: boolean;
  private nodePool: GlNodePool | null;
  private sampleCount: number;
  private lost = false;
  private destroyed = false;

  private canvasWidth = 1;
  private canvasHeight = 1;
  private fullTargets: GlSceneTargets | null = null;
  private motionTargets: GlSceneTargets | null = null;
  private accum: GlAccumTarget | null = null;
  private lastRenderScale = 1;
  private lastDrawCallCount = 0;

  private readonly uniformCache = new Float32Array(SCENE_UNIFORM_FLOATS);
  private readonly uniformCacheU32 = new Uint32Array(this.uniformCache.buffer);
  private readonly pointParams = new Float32Array(POINT_PARAMS_FLOATS);
  private readonly viewMatrix = new Float32Array(16);
  private readonly renderProj = new Float32Array(16);
  private readonly drawProj = new Float32Array(16);
  private readonly drawViewProj = new Float32Array(16);
  private depthNear = 0.05;
  private depthFar = 100_000;
  private jitterX = 0;
  private jitterY = 0;

  private edlEnabled = false;
  private edlStrength = 1.0;
  private edlRadiusPx = 1.4;
  /** EDL uniforms of the frame being drawn: strength, radius px, enabled, target/canvas scale. */
  private readonly edlUniform = new Float32Array(4);

  private pointFilterEnabled = 0;
  private pointFilterMask: [number, number, number, number] = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
  private colorMode: PointColorMode = 'rgb';
  private maxPointPixels = POINT_MAX_PX;

  private hmOriginX = 0;
  private hmOriginZ = 0;
  private hmScaleX = 1;
  private hmScaleZ = 1;
  private snowMode: 0 | 1 | 2 = 0;
  private snowOriginX = 0;
  private snowOriginZ = 0;
  private snowScaleX = 1;
  private snowScaleZ = 1;
  private slopeEnabled = 0;
  private slopeOpacity = 0.5;
  private slopeFilter: GlFilter = 'linear';
  private altitudeEnabled = 0;
  private altitudeOpacity = 0.5;
  private altitudeFilter: GlFilter = 'linear';
  private maxAltitude = DEFAULT_MAX_ALTITUDE_M;
  private shadowEnabled = 0;
  private shadowOpacity = 0.5;
  private sunlightEnabled = 0;
  private sunlightMapEnabled = 0;
  private sunlightMapOpacity = 0.5;
  private sunIntensity = 1.0;
  private exposure = 1.0;
  private sunDir: [number, number, number] = [0.28, 0.78, 0.55];
  private sunColor: [number, number, number] = [1.0, 0.98, 0.95];
  private skyColor: [number, number, number] = [0.65, 0.75, 0.85];
  private sunDiscPos: [number, number, number] | null = null;
  private sunDiscRadius = 0;
  private trajectoryEnabled = false;
  private trajectory: { vao: WebGLVertexArrayObject; buffer: WebGLBuffer; count: number } | null = null;

  private terrain: GlTerrainLod | null = null;
  private previewMesh: GlMesh | null = null;
  private routeMesh: GlMesh | null = null;
  private analysisMesh: GlMesh | null = null;

  /** @throws when WebGL 2 is unavailable or a shader fails on this driver (the caller falls back). */
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error(translateAppText('WebGL 2 indisponible dans ce navigateur'));
    this.gl = gl;

    const strings = readContextStrings(gl);
    this.rendererName = strings.renderer;
    const info = resolveWebglPlatformInfo(strings.vendor, strings.renderer);
    const profile = fitProfileToMemory(info.profile, (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    this.maxTextureSize = Math.max(2048, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048);
    const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    profile.maxCanvasDim = Math.min(
      profile.maxCanvasDim,
      this.maxTextureSize,
      Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 2048,
      maxViewport ? Math.min(maxViewport[0]!, maxViewport[1]!) : 2048,
    );
    this.platform = profile;
    this.canAccumulate = !!(gl.getExtension('EXT_color_buffer_float') ?? gl.getExtension('EXT_color_buffer_half_float'));
    const maxSamples = Number(gl.getParameter(gl.MAX_SAMPLES)) || 0;
    // MSAA ×4 (with alpha-to-coverage on point edges) only where fill rate is cheap, as on WebGPU.
    this.sampleCount = profile.tier === 'discrete' && maxSamples >= 4 ? 4 : 1;

    this.programs = {
      point: createGlProgram(gl, POINT_VS, POINT_FS, 'points'),
      pointSquare: createGlProgram(gl, POINT_VS, POINT_SQUARE_FS, 'points (square)'),
      shading: createGlProgram(gl, SHADING_VS, SHADING_FS, 'point shading', SHADING_VARYINGS),
      terrain: createGlProgram(gl, TERRAIN_VS, TERRAIN_FS, 'terrain'),
      colorMesh: createGlProgram(gl, COLOR_MESH_VS, COLOR_MESH_FS, 'colour mesh'),
      sunDisc: createGlProgram(gl, SUN_DISC_VS, SUN_DISC_FS, 'sun disc'),
      blit: createGlProgram(gl, FULLSCREEN_VS, BLIT_FS, 'blit'),
      edl: createGlProgram(gl, FULLSCREEN_VS, EDL_FS, 'EDL'),
      accumulate: createGlProgram(gl, FULLSCREEN_VS, EDL_ACCUMULATE_FS, 'accumulate'),
      present: createGlProgram(gl, FULLSCREEN_VS, PRESENT_FS, 'present'),
    };
    this.pushBackLocation = gl.getUniformLocation(this.programs.terrain, 'u_pushBack');
    this.passLocations = new Map([this.programs.edl, this.programs.accumulate].map((program) => [program, {
      edl: gl.getUniformLocation(program, 'u_edl'),
      depthRange: gl.getUniformLocation(program, 'u_depthRange'),
    }]));

    const emptyVao = gl.createVertexArray();
    const sceneUbo = gl.createBuffer();
    const pointParamsUbo = gl.createBuffer();
    if (!emptyVao || !sceneUbo || !pointParamsUbo) throw new Error('WebGL resource allocation failed');
    this.emptyVao = emptyVao;
    this.sceneUbo = sceneUbo;
    this.pointParamsUbo = pointParamsUbo;
    gl.bindBuffer(gl.UNIFORM_BUFFER, sceneUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.uniformCache.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, pointParamsUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.pointParams.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.textures = {
      heightTex: createFloatTexture(gl, 1, 1, new Float32Array([0])),
      snowTex: createFloatTexture(gl, 1, 1, new Float32Array([0])),
      slopeTex: createRgbaTexture(gl, SLOPE_RAMP_WIDTH, 1, new Uint8Array(SLOPE_RAMP_WIDTH * 4), 'linear'),
      altitudeTex: createRgbaTexture(gl, ALTITUDE_RAMP_WIDTH, 1, new Uint8Array(ALTITUDE_RAMP_WIDTH * 4), 'linear'),
      shadowTex: createFloatTexture(gl, 1, 1, new Float32Array([0])),
      sunlightMapTex: createRgbaTexture(gl, 1, 1, new Uint8Array([0, 0, 0, 0])),
    };
    this.nodePool = new GlNodePool(gl, NODE_POOL_CAPACITY);
    this.timer = new GlFrameTimer(gl);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);

    console.log(
      `[LiDAR GPU] WebGL 2 · ${strings.renderer || '?'} · tier: ${profile.tier} · MSAA ×${this.sampleCount}` +
      ` · accumulation: ${this.canAccumulate ? 'rgba16f' : 'off'} · frame timing: ${this.timer.usesQueries ? 'timer-query' : 'cadence'}`,
    );
    this.resize(canvas.width, canvas.height);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.lost || this.destroyed) return;
    this.lost = true;
    console.error('[LiDAR GPU] WebGL context lost');
    this.onDeviceLost?.({ reason: 'context-lost', message: translateAppText('Contexte WebGL perdu') });
  };

  // --- Stats & capabilities ---

  getGpuFrameMs(): number {
    return this.timer.getFrameMs();
  }

  getGpuShadeMs(): number {
    return this.timer.getShadeMs();
  }

  hasPreciseGpuTiming(): boolean {
    return this.timer.usesQueries;
  }

  getLastRenderStats(): RenderStats {
    return {
      drawCalls: this.lastDrawCallCount,
      outOfMemory: 0,
      terrainTriangles: this.terrain && this.terrainVisible ? this.terrain.lastTriangles : 0,
    };
  }

  getNodeCapacity(): number {
    return this.nodePool?.capacity ?? 0;
  }

  getLastRenderScale(): number {
    return this.lastRenderScale;
  }

  async disableMsaa(): Promise<boolean> {
    if (this.sampleCount === 1 || this.lost) return false;
    this.sampleCount = 1;
    this.resize(this.canvasWidth, this.canvasHeight);
    console.log('[LiDAR GPU] MSAA disabled to keep the frame rate.');
    return true;
  }

  // --- SceneNodeUploader ---

  uploadNode(node: SceneNode, block: ArrayBuffer): boolean {
    if (!this.nodePool || this.lost) return false;
    return this.nodePool.upload(node, block);
  }

  releaseNode(node: SceneNode): void {
    this.nodePool?.release(node);
  }

  // --- State ---

  setEyeLevelPoints(enabled: boolean): void {
    this.maxPointPixels = enabled ? EYE_LEVEL_POINT_MAX_PX : POINT_MAX_PX;
  }

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

  private invalidateShading(): void {
    this.nodePool?.invalidateShading();
  }

  /** Replaces a scene texture (same unit), dropping the previous one. */
  private replaceTexture(key: keyof SceneTextures, texture: WebGLTexture): void {
    this.gl.deleteTexture(this.textures[key]);
    this.textures[key] = texture;
    this.invalidateShading();
  }

  private floatGridTexture(data: Float32Array, width: number, height: number): WebGLTexture {
    const fitted = fitGridToTextureSize(data, width, height, 1, this.maxTextureSize);
    return createFloatTexture(this.gl, fitted.width, fitted.height, fitted.data);
  }

  setHeightmap(params: HeightmapParams): void {
    if (this.lost) return;
    this.hmOriginX = params.originX;
    this.hmOriginZ = params.originZ;
    this.hmScaleX = params.scaleX;
    this.hmScaleZ = params.scaleZ;
    this.replaceTexture('heightTex', this.floatGridTexture(flipRows(params.data, params.width, params.height), params.width, params.height));
  }

  setSnow(params: SnowParams): void {
    if (this.lost) return;
    this.snowOriginX = params.originX;
    this.snowOriginZ = params.originZ;
    this.snowScaleX = params.scaleX;
    this.snowScaleZ = params.scaleZ;
    this.replaceTexture('snowTex', this.floatGridTexture(params.data, params.width, params.height));
  }

  setSnowMode(mode: 0 | 1 | 2): void {
    if (this.snowMode !== mode) this.invalidateShading();
    this.snowMode = mode;
  }

  setSlopeState(state: ViewerSlopeState): void {
    if (this.lost) return;
    this.slopeEnabled = state.enabled ? 1 : 0;
    this.slopeOpacity = (state.opacity ?? 50) / 100;
    if (state.bands && state.bands.length > 0) {
      writeRgbaTexture(this.gl, this.textures.slopeTex, SLOPE_RAMP_WIDTH, 1,
        buildSlopeRampData(state.bands, state.colorization, SLOPE_RAMP_WIDTH));
    }
    const filter: GlFilter = state.colorization === 'stepped' ? 'nearest' : 'linear';
    if (filter !== this.slopeFilter) {
      this.slopeFilter = filter;
      setTextureFilter(this.gl, this.textures.slopeTex, filter);
    }
    this.invalidateShading();
  }

  setAltitudeState(state: ViewerAltitudeState): void {
    if (this.lost) return;
    this.altitudeEnabled = state.enabled ? 1 : 0;
    this.altitudeOpacity = (state.opacity ?? 50) / 100;
    if (state.bands && state.bands.length > 0) {
      writeRgbaTexture(this.gl, this.textures.altitudeTex, ALTITUDE_RAMP_WIDTH, 1,
        buildAltitudeRampData(state.bands, state.colorization, this.maxAltitude, ALTITUDE_RAMP_WIDTH));
    }
    const filter: GlFilter = state.colorization === 'stepped' ? 'nearest' : 'linear';
    if (filter !== this.altitudeFilter) {
      this.altitudeFilter = filter;
      setTextureFilter(this.gl, this.textures.altitudeTex, filter);
    }
    this.invalidateShading();
  }

  setMaxAltitude(maxAltitude: number): void {
    this.maxAltitude = maxAltitude;
    this.invalidateShading();
  }

  setSunlightRenderState(renderState: SolarRenderState): void {
    if (this.lost) return;
    const gl = this.gl;
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

    if (renderState.shadowMapData && renderState.shadowMapWidth > 0 && renderState.shadowMapHeight > 0) {
      const sw = renderState.shadowMapWidth;
      const sh = renderState.shadowMapHeight;
      this.replaceTexture('shadowTex', this.floatGridTexture(unitFloatsFromBytes(renderState.shadowMapData, sw * sh), sw, sh));
    }
    if (renderState.sunlightMapRgba && renderState.sunlightMapWidth > 0 && renderState.sunlightMapHeight > 0) {
      const fitted = fitGridToTextureSize(renderState.sunlightMapRgba, renderState.sunlightMapWidth, renderState.sunlightMapHeight, 4, this.maxTextureSize);
      this.replaceTexture('sunlightMapTex', createRgbaTexture(gl, fitted.width, fitted.height, fitted.data));
    }

    this.trajectoryEnabled = renderState.trajectoryEnabled;
    this.sunDiscPos = renderState.sunDiscPos;
    this.sunDiscRadius = renderState.sunDiscRadius;
    this.deleteTrajectory();
    if (renderState.trajectoryVertices && renderState.trajectoryVertexCount > 0) {
      // Line strip of pos.xyz + colour.rgba (floats).
      const buffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, renderState.trajectoryVertices);
      const vao = gl.createVertexArray();
      if (vao) {
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.trajectory = { vao, buffer, count: renderState.trajectoryVertexCount };
      } else {
        gl.deleteBuffer(buffer);
      }
    }
    this.invalidateShading();
  }

  private deleteTrajectory(): void {
    if (!this.trajectory) return;
    this.gl.deleteVertexArray(this.trajectory.vao);
    this.gl.deleteBuffer(this.trajectory.buffer);
    this.trajectory = null;
  }

  setPointFilterState(state: ViewerPointFilterState): void {
    this.pointFilterEnabled = state.enabled ? 1.0 : 0.0;
    this.pointFilterMask = computePointFilterBitmasks(state.enabled, state.categories);
  }

  // --- Meshes ---

  setTerrainMesh(mesh: TerrainMeshData): void {
    if (this.lost) return;
    this.terrain?.destroy();
    this.terrain = new GlTerrainLod(this.gl, mesh);
  }

  /**
   * Indexed mesh: `withNormals` = 6 floats per vertex (position + normal,
   * terrain layout), else 3 (position); RGBA8 colours; uint32 indices.
   */
  private createMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count: number, withNormals: boolean): GlMesh | null {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) return null;
    const vertexBuffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, vertices);
    const colorBuffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, colors);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    const stride = withNormals ? 24 : 12;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    const colorLocation = withNormals ? 2 : 1;
    if (withNormals) {
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    const indexBuffer = gl.createBuffer();
    if (!indexBuffer) {
      gl.bindVertexArray(null);
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(vertexBuffer);
      gl.deleteBuffer(colorBuffer);
      return null;
    }
    // Element array binding recorded in the VAO.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, buffers: [vertexBuffer, colorBuffer, indexBuffer], count };
  }

  private deleteMesh(mesh: GlMesh | null): void {
    if (!mesh) return;
    this.gl.deleteVertexArray(mesh.vao);
    for (const buffer of mesh.buffers) this.gl.deleteBuffer(buffer);
  }

  setPreviewMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    this.clearPreviewMesh();
    if (this.lost || vertices.length === 0 || indices.length === 0) return;
    this.previewMesh = this.createMesh(vertices, colors, indices, indices.length, true);
  }

  clearPreviewMesh(): void {
    this.deleteMesh(this.previewMesh);
    this.previewMesh = null;
  }

  setRouteMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    this.clearRouteMesh();
    if (this.lost || vertices.length === 0 || indices.length === 0) return;
    this.routeMesh = this.createMesh(vertices, colors, indices, count ?? indices.length, false);
  }

  clearRouteMesh(): void {
    this.deleteMesh(this.routeMesh);
    this.routeMesh = null;
  }

  setAnalysisMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    this.clearAnalysisMesh();
    if (this.lost || vertices.length === 0 || indices.length === 0) return;
    this.analysisMesh = this.createMesh(vertices, colors, indices, indices.length, false);
  }

  clearAnalysisMesh(): void {
    this.deleteMesh(this.analysisMesh);
    this.analysisMesh = null;
  }

  // --- Targets ---

  resize(width: number, height: number): void {
    if (this.lost || this.destroyed) return;
    const gl = this.gl;
    // The browser may cap the drawing buffer below the canvas size.
    this.canvasWidth = Math.max(1, Math.min(width, gl.drawingBufferWidth || width));
    this.canvasHeight = Math.max(1, Math.min(height, gl.drawingBufferHeight || height));
    destroyGlSceneTargets(gl, this.fullTargets);
    destroyGlSceneTargets(gl, this.motionTargets);
    destroyGlAccumTarget(gl, this.accum);
    this.fullTargets = createGlSceneTargets(gl, this.canvasWidth, this.canvasHeight, this.sampleCount);
    this.motionTargets = this.motionScale < 1
      ? createGlSceneTargets(
        gl,
        Math.max(1, Math.round(this.canvasWidth * this.motionScale)),
        Math.max(1, Math.round(this.canvasHeight * this.motionScale)),
        this.sampleCount,
      )
      : null;
    this.accum = this.canAccumulate ? createGlAccumTarget(gl, this.canvasWidth, this.canvasHeight) : null;
  }

  // --- Camera ---

  setSubpixelJitter(x: number, y: number): void {
    // Without an accumulation target the still frames are not averaged:
    // jittering them would only make the image shimmer.
    this.jitterX = this.canAccumulate ? x : 0;
    this.jitterY = this.canAccumulate ? y : 0;
  }

  setDepthRange(near: number, far: number): void {
    if (!(near > 0) || !(far > near)) return;
    this.depthNear = near;
    this.depthFar = far;
  }

  updateCamera(viewMat: Float32Array, projMat: Float32Array, camPos: [number, number, number] | Float32Array): void {
    if (this.lost) return;
    const view = this.viewMatrix;
    const proj = this.renderProj;
    view.set(viewMat);
    proj.set(projMat);
    this.lastProjScaleY = proj[5]!;
    const pos = camPos && camPos.length >= 3 ? vec3Of(camPos) : cameraPositionFromView(view);
    this.lastCamPos = pos;
    // LOD selection and culling read the render projection, as on WebGPU.
    mat4MultiplyInto(this.lastViewProj, proj, view);

    // Drawn with the same lens and a finite depth range (no clip control in WebGL).
    const near = this.depthNear;
    const far = this.depthFar;
    const draw = this.drawProj;
    draw.set(proj);
    draw[2] = 0;
    draw[6] = 0;
    draw[10] = (far + near) / (near - far);
    draw[11] = -1;
    draw[14] = (2 * far * near) / (near - far);
    draw[15] = 0;
    const vp = mat4MultiplyInto(this.drawViewProj, draw, view);
    if (this.jitterX !== 0 || this.jitterY !== 0) {
      // Clip-space shift by (dx, dy)·w: the whole image moves by the offset in pixels.
      const dx = (2 * this.jitterX) / this.canvasWidth;
      const dy = (2 * this.jitterY) / this.canvasHeight;
      for (let col = 0; col < 4; col++) {
        vp[col * 4] = vp[col * 4]! + dx * vp[col * 4 + 3]!;
        vp[col * 4 + 1] = vp[col * 4 + 1]! + dy * vp[col * 4 + 3]!;
      }
    }
    packSceneUniforms(this.uniformCache, this.uniformCacheU32, vp, view, pos, {
      pointSize: this.pointSize,
      canvasWidth: this.canvasWidth,
      canvasHeight: this.canvasHeight,
      sunDir: this.sunDir,
      hmOriginX: this.hmOriginX,
      hmOriginZ: this.hmOriginZ,
      hmScaleX: this.hmScaleX,
      hmScaleZ: this.hmScaleZ,
      density: 1,
      centerAltitude: this.centerAltitude,
      maxAltitude: this.maxAltitude,
      colorModeIndex: COLOR_MODE_INDEX[this.colorMode],
      snowMode: this.snowMode,
      snowOriginX: this.snowOriginX,
      snowOriginZ: this.snowOriginZ,
      snowScaleX: this.snowScaleX,
      snowScaleZ: this.snowScaleZ,
      slopeEnabled: this.slopeEnabled,
      slopeOpacity: this.slopeOpacity,
      altitudeEnabled: this.altitudeEnabled,
      altitudeOpacity: this.altitudeOpacity,
      sunlightEnabled: this.sunlightEnabled,
      shadowEnabled: this.shadowEnabled,
      shadowOpacity: this.shadowOpacity,
      sunlightMapEnabled: this.sunlightMapEnabled,
      sunlightMapOpacity: this.sunlightMapOpacity,
      sunIntensity: this.sunIntensity,
      exposure: this.exposure,
      sunColor: this.sunColor,
      skyColor: this.skyColor,
      sunDiscPos: this.sunDiscPos,
      sunDiscRadius: this.sunDiscRadius,
      pointFilterEnabled: this.pointFilterEnabled,
      pointFilterMask: this.pointFilterMask,
    });
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.sceneUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.uniformCache);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  }

  /** Per-frame sprite and EDL parameters for scene targets of `width`×`height` (`scale` of the canvas). */
  private writeFrameParams(width: number, height: number, scale: number): void {
    const p = this.pointParams;
    p[0] = POINT_MIN_PX;
    p[1] = this.maxPointPixels * scale;
    p[2] = this.fixedPointPixels * scale;
    p[3] = Math.abs(this.lastProjScaleY) * height * 0.5;
    p[4] = width;
    p[5] = height;
    p[6] = this.sampleCount > 1 ? 1 : 0;
    p[7] = this.pointSize;
    p[8] = this.adaptivePointSize
      ? ADAPTIVE_SPACING_FACTOR * (this.pointSizeReference > 0 ? this.pointSize / this.pointSizeReference : 1)
      : 0;
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.pointParamsUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, p);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.edlUniform[0] = this.edlStrength;
    this.edlUniform[1] = Math.max(1, this.edlRadiusPx * scale);
    this.edlUniform[2] = this.edlEnabled ? 1 : 0;
    this.edlUniform[3] = scale;
  }

  private bindSceneResources(): void {
    const gl = this.gl;
    gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_BINDING.scene, this.sceneUbo);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_BINDING.pointParams, this.pointParamsUbo);
    for (const key of Object.keys(SCENE_TEXTURE_UNITS) as Array<keyof SceneTextures>) {
      gl.activeTexture(gl.TEXTURE0 + SCENE_TEXTURE_UNITS[key]);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[key]);
    }
  }

  private bindPassTexture(unit: number, texture: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }

  private setPassUniforms(program: WebGLProgram): void {
    const locations = this.passLocations.get(program);
    if (!locations) return;
    this.gl.uniform4fv(locations.edl, this.edlUniform);
    this.gl.uniform2f(locations.depthRange, this.depthNear, this.depthFar);
  }

  private drawMesh(mesh: GlMesh): void {
    this.gl.bindVertexArray(mesh.vao);
    this.gl.drawElements(this.gl.TRIANGLES, mesh.count, this.gl.UNSIGNED_INT, 0);
    this.lastDrawCallCount += 1;
  }

  // --- Frame ---

  renderScene(nodes: readonly SceneNode[], options: RenderSceneOptions = {}): void {
    if (this.lost || this.destroyed || !this.fullTargets || !this.nodePool) return;
    const gl = this.gl;
    this.lastDrawCallCount = 0;
    const reduced = options.motion === true && this.motionTargets !== null;
    const accumulateSample = !reduced && options.accumulate !== undefined && this.accum ? options.accumulate : -1;
    const targets = reduced ? this.motionTargets! : this.fullTargets;
    const scale = targets.width / this.canvasWidth;
    this.lastRenderScale = scale;
    this.writeFrameParams(targets.width, targets.height, scale);

    const clearR = this.sunlightEnabled ? this.skyColor[0] : 0.76;
    const clearG = this.sunlightEnabled ? this.skyColor[1] : 0.87;
    const clearB = this.sunlightEnabled ? this.skyColor[2] : 0.96;
    const timed = this.timer.beginFrame();
    this.bindSceneResources();

    if (timed) this.timer.beginPass(TIMED_PASS.shading);
    this.nodePool.prepareFrame(nodes, this.programs.shading);
    if (timed) this.timer.endPass();

    // Scene pass.
    const msaa = targets.msFbo !== null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msFbo ?? targets.fbo);
    gl.viewport(0, 0, targets.width, targets.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearColor(clearR, clearG, clearB, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (timed) this.timer.beginPass(TIMED_PASS.scene);

    // Points first (front to back), then the terrain only fills what is left.
    const roundPoints = !(options.motion && this.motionSquares);
    gl.useProgram(roundPoints ? this.programs.point : this.programs.pointSquare);
    if (roundPoints && msaa) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    this.lastDrawCallCount += this.nodePool.draw(nodes);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);

    if ((this.terrain && this.terrainVisible) || this.previewMesh) gl.useProgram(this.programs.terrain);
    if (this.terrain && this.terrainVisible) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(TERRAIN_POLYGON_OFFSET_FACTOR, 0);
      // Levels picked at the canvas resolution, like the points.
      const focalPx = Math.abs(this.lastProjScaleY) * this.canvasHeight * 0.5;
      this.lastDrawCallCount += this.terrain.draw(this.pushBackLocation, this.lastViewProj, this.lastCamPos, focalPx);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.CULL_FACE);
    }

    if (this.previewMesh) {
      gl.uniform1f(this.pushBackLocation, 0);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawMesh(this.previewMesh);
    }

    // Overlays: depth-tested, no depth write.
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    if (this.trajectoryEnabled && this.trajectory && this.trajectory.count > 1) {
      gl.useProgram(this.programs.colorMesh);
      gl.depthFunc(gl.LEQUAL);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      gl.bindVertexArray(this.trajectory.vao);
      gl.drawArrays(gl.LINE_STRIP, 0, this.trajectory.count);
      this.lastDrawCallCount += 1;
    }
    if (this.trajectoryEnabled && this.sunDiscPos) {
      gl.useProgram(this.programs.sunDisc);
      gl.depthFunc(gl.ALWAYS);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.lastDrawCallCount += 1;
    }
    if ((this.analysisMesh && this.analysisMesh.count > 0) || (this.routeMesh && this.routeMesh.count > 0)) {
      gl.useProgram(this.programs.colorMesh);
      gl.depthFunc(gl.LEQUAL);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (this.analysisMesh && this.analysisMesh.count > 0) this.drawMesh(this.analysisMesh);
      if (this.routeMesh && this.routeMesh.count > 0) this.drawMesh(this.routeMesh);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    if (timed) this.timer.endPass();

    resolveGlSceneTargets(gl, targets, this.edlEnabled);

    // Full-screen pass(es) to the canvas.
    if (timed) this.timer.beginPass(TIMED_PASS.edl);
    gl.bindVertexArray(this.emptyVao);
    this.bindPassTexture(PASS_TEXTURE_UNITS.colorTex, targets.colorTex);
    this.bindPassTexture(PASS_TEXTURE_UNITS.depthTex, targets.depthTex);
    if (accumulateSample >= 0 && this.accum) {
      // EDL (or a plain copy) in linear light, blended into the running mean:
      // weight 1 / (n + 1), the first sample replaces the history.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
      gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
      if (accumulateSample === 0) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const weight = 1 / (accumulateSample + 1);
      gl.useProgram(this.programs.accumulate);
      this.setPassUniforms(this.programs.accumulate);
      gl.enable(gl.BLEND);
      gl.blendColor(weight, weight, weight, weight);
      gl.blendFunc(gl.CONSTANT_COLOR, gl.ONE_MINUS_CONSTANT_COLOR);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
      this.bindPassTexture(PASS_TEXTURE_UNITS.accumTex, this.accum.texture);
      gl.useProgram(this.programs.present);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
      const program = this.edlEnabled ? this.programs.edl : this.programs.blit;
      gl.useProgram(program);
      this.setPassUniforms(program);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
    if (timed) this.timer.endPass();
    this.timer.endFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.timer.destroy();
    this.terrain?.destroy();
    this.terrain = null;
    this.clearPreviewMesh();
    this.clearRouteMesh();
    this.clearAnalysisMesh();
    this.deleteTrajectory();
    this.nodePool?.destroy();
    this.nodePool = null;
    destroyGlSceneTargets(gl, this.fullTargets);
    destroyGlSceneTargets(gl, this.motionTargets);
    destroyGlAccumTarget(gl, this.accum);
    this.fullTargets = null;
    this.motionTargets = null;
    this.accum = null;
    for (const texture of Object.values(this.textures)) gl.deleteTexture(texture);
    for (const program of Object.values(this.programs)) gl.deleteProgram(program);
    gl.deleteBuffer(this.sceneUbo);
    gl.deleteBuffer(this.pointParamsUbo);
    gl.deleteVertexArray(this.emptyVao);
    // Frees the GPU memory now rather than at garbage collection.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
