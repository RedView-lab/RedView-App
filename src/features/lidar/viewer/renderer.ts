import type { PlatformProfile } from './lod/types';
import type { SceneNode } from './lod/sceneLod';
import { cameraForwardFromView, cameraPositionFromView, mat4MultiplyInto, vec3Of } from './renderer/math';
import { NodeGpuPool } from './renderer/nodePool';
import { requestLidarGpu, showDeviceLostNotice } from './renderer/device';
import { ACCUMULATION_FORMAT, createRendererPipelines, type RendererPipelines } from './renderer/rendererPipeline';
import {
  createFloatTexture,
  createMeshBuffers,
  createRampSampler,
  createRampTexture,
  createRgbaTexture,
  createUniformBuffer,
  createVertexBuffer,
  destroyMeshBuffers,
  drawMesh,
  flipRows,
  unitFloatsFromBytes,
  writeRampTexture,
  type MeshBuffers,
} from './renderer/gpuResources';
import { createSceneTargets, destroySceneTargets, type SceneTargets } from './renderer/sceneTargets';
import { TerrainLod } from './renderer/terrainLod';
import type { TerrainMeshData } from './renderer/terrainLodCore';
import { packSceneUniforms, SCENE_UNIFORM_FLOATS } from './renderer/sceneUniforms';
import { EDL_PARAMS_FLOATS, POINT_PARAMS_FLOATS } from './renderer/shaders';
import type { HeightmapParams, SnowParams } from './renderer/types';
import { buildSlopeRampData } from './slope/slopeRamp';
import { buildAltitudeRampData } from './altitude/altitudeRamp';
import type { ViewerSlopeState, ViewerAltitudeState } from './rightPanel/types';
import type { ViewerPointFilterState } from './pointFilter';
import type { SolarRenderState } from '../viewer-webgl/sunlightController';
import { GpuFrameTimer, TIMED_PASS } from './renderer/gpuTimer';
import type {
  LidarRenderer,
  PointColorMode,
  RenderSceneOptions,
  RendererLostInfo,
} from './renderer/sceneRenderer';
import {
  EYE_LEVEL_POINT_MAX_PX,
  fillEdlParams,
  fillPointParams,
  NODE_POOL_CAPACITY,
  POINT_MAX_PX,
  SceneShadingState,
  type RampFilter,
} from './renderer/sceneShadingState';
import { PhotoRenderer } from './photoMode/renderer/photoRenderer';
import { PHOTO_MODE_ENABLED } from './photoMode/featureFlag';
import type { PhotoModeRenderer } from './photoMode/renderer/types';

export type { HeightmapParams } from './renderer/types';

/**
 * Renderer WebGPU du nuage de points.
 *
 * Image = passe de calcul d'ombrage (nœuds dessinés nouveaux, ou périmés
 * après un changement de superposition) → passe de scène (depth32float en
 * Z inversé, MSAA ×4 sur GPU dédié), directement dans le canvas, ou, EDL
 * activé, dans une cible hors écran que la passe Eye-Dome Lighting résout
 * vers le canvas. Les images fixes en cours d'anticrénelage (`accumulate`,
 * voir RestRefinement) sont plutôt résolues dans une moyenne glissante
 * rgba16float linéaire, puis présentées.
 * Les points vivent dans les nœuds LOD chargés par `SceneLod` ; cette classe
 * est son back-end de résidence GPU (`SceneNodeUploader`).
 */
export class WebGpuLidarRenderer implements LidarRenderer {
  readonly backend = 'webgpu' as const;
  canvas!: HTMLCanvasElement;
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
  /** Cibles à la taille du canvas (chemin EDL ; sans EDL, la scène va directement dans le canvas). */
  private fullTargets: SceneTargets | null = null;
  /** Cibles réduites dessinées pendant que la caméra bouge (`motionScale` < 1), agrandies vers le canvas. */
  private motionTargets: SceneTargets | null = null;
  private blitSampler!: GPUSampler;
  /**
   * Résolution de la scène pendant que la caméra bouge, en part du canvas
   * (1 = désactivé). C'est le taux de remplissage qui limite les GPU
   * intégrés : 0,7 dessine moitié moins de pixels. À fixer avant `resize`.
   */
  motionScale = 1;
  /** Sprites carrés (sans discard) pendant que la caméra bouge. */
  motionSquares = true;
  private lastRenderScale = 1;
  /** Moyenne glissante des images fixes (taille du canvas, lumière linéaire) et son bind group de présentation. */
  private accumTexture: GPUTexture | null = null;
  private accumView: GPUTextureView | null = null;
  private presentBindGroup: GPUBindGroup | null = null;
  /** Décalage sous-pixel (px du canvas) de la projection, pour les images fixes accumulées. */
  private jitterX = 0;
  private jitterY = 0;
  private readonly jitteredViewProj = new Float32Array(16);

  private uniformCache = new Float32Array(SCENE_UNIFORM_FLOATS);
  private uniformCacheU32 = new Uint32Array(this.uniformCache.buffer);
  private pointParams = new Float32Array(POINT_PARAMS_FLOATS);
  private edlParams = new Float32Array(EDL_PARAMS_FLOATS);

  /** État des superpositions et de l'éclairage, partagé avec le renderer WebGL 2. */
  private readonly shading = new SceneShadingState();

  private trajectoryBuffer: GPUBuffer | null = null;
  private trajectoryVertexCount = 0;

  private heightTexture!: GPUTexture;
  private snowTexture!: GPUTexture;

  private slopeTexture!: GPUTexture;
  private slopeSampler!: GPUSampler;
  private slopeFilter: RampFilter = 'linear';

  private altitudeTexture!: GPUTexture;
  private altitudeSampler!: GPUSampler;
  private altitudeFilter: RampFilter = 'linear';
  centerAltitude = 0;

  private shadowTexture!: GPUTexture;
  private sunlightMapTexture!: GPUTexture;

  private _cachedViewProj = new Float32Array(16);
  private _lastView = new Float32Array(16);
  private _lastProj = new Float32Array(16);

  /** Maillage du MNT qui comble les trous entre les points, dessiné par morceau au niveau dont la vue a besoin. */
  private terrain: TerrainLod | null = null;
  private previewMesh: MeshBuffers | null = null;
  private routeMesh: MeshBuffers | null = null;
  /** Zones d'analyse drapées des outils du viewer (portée d'avalanche, visibilité). */
  private analysisMesh: MeshBuffers | null = null;
  private canvasWidth = 1;
  private canvasHeight = 1;
  /** Diamètre des points en mètres, identique pour tous (projeté, borné en pixels). */
  pointSize = 0.3;
  /** Point diameter in device pixels; 0 = adaptive (world size, clamped in pixels). */
  fixedPointPixels = 0;
  /** Plus grand diamètre de point projeté (px de l'écran) ; abaissé pour la vue à hauteur d'œil. */
  private maxPointPixels = POINT_MAX_PX;
  /**
   * Les niveaux LOD plus grossiers dessinés comme les plus fins à l'écran
   * grossissent jusqu'à leur propre espacement (taille adaptative à la
   * Potree) : pas de trous là où le budget ou la distance arrêtent le
   * raffinement.
   */
  adaptivePointSize = true;
  /** `pointSize` par défaut de la scène ; la taille adaptative suit les changements que l'utilisateur lui apporte. */
  pointSizeReference = 0;
  terrainVisible = true;

  private edlEnabled = false;
  private edlStrength = 1.0;
  private edlRadiusPx = 1.4;

  lastViewProj: Float32Array = new Float32Array(16);
  lastCamPos: Float32Array | [number, number, number] = new Float32Array(3);
  lastCamFwd: Float32Array | [number, number, number] = new Float32Array([0, 0, -1]);

  deviceLost = false;
  /** Appelé une fois quand le device est perdu, pour toute autre raison que `destroy()`. */
  onDeviceLost: ((info: RendererLostInfo) => void) | null = null;
  platform: PlatformProfile | null = null;
  /** proj[1][1] de la dernière mise à jour de la caméra (focale de la taille écran du LOD). */
  lastProjScaleY = 1;
  private gpuTimer: GpuFrameTimer | null = null;
  private lastDrawCallCount = 0;
  /** Mode photo (éclairage différé, ciel, nuages, ombres des points) ; WebGPU seulement. */
  private photoRenderer: PhotoRenderer | null = null;
  /** État du mode photo pour lequel l'ombrage des points a été écrit en dernier. */
  private photoShading = false;
  /** Matrice avec laquelle la dernière image a été dessinée (décalée pendant l'accumulation). */
  private readonly drawViewProj = new Float32Array(16);

  get photo(): PhotoModeRenderer | null {
    return this.photoRenderer;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    const { device, profile } = await requestLidarGpu();
    this.device = device;
    this.platform = profile;
    // MSAA ×4 (avec alpha-to-coverage sur le bord des points) seulement là où le taux de remplissage ne coûte pas cher.
    this.sampleCount = profile.tier === 'discrete' ? 4 : 1;
    this.gpuTimer = new GpuFrameTimer(this.device);
    console.log(
      `[LiDAR GPU] Tier: ${profile.tier} · MSAA ×${this.sampleCount}` +
      ` · frame timing: ${this.gpuTimer.usesTimestamps ? 'timestamp-query' : 'onSubmittedWorkDone'}`,
    );

    this.device.lost.then((info) => {
      console.error(`[LiDAR GPU] Device lost: reason=${info.reason}, message=${info.message}`);
      this.deviceLost = true;
      if (info.reason !== 'destroyed') {
        showDeviceLostNotice(info);
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

    // Photo mode frozen (photoMode/featureFlag.ts): nothing created.
    if (PHOTO_MODE_ENABLED) {
      this.photoRenderer = new PhotoRenderer({
        device: this.device,
        canvasFormat: this.format,
        tier: profile.tier,
        nodePool: this.nodePool,
        layouts: {
          scene: this.pipelines.sceneBindGroupLayout,
          pointParams: this.pipelines.pointParamsBindGroupLayout,
          node: this.pipelines.nodeBindGroupLayout,
          terrainLod: this.pipelines.terrainLodBindGroupLayout,
        },
        timer: this.gpuTimer,
      });
    }

    this.cameraBuffer = createUniformBuffer(this.device, this.uniformCache.byteLength);
    this.pointParamsBuffer = createUniformBuffer(this.device, this.pointParams.byteLength);
    this.edlParamsBuffer = createUniformBuffer(this.device, this.edlParams.byteLength);
    this.pointParamsBindGroup = this.device.createBindGroup({
      layout: this.pipelines.pointParamsBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.pointParamsBuffer } },
        { binding: 1, resource: { buffer: this.nodePool.childMaskBuffer } },
      ],
    });

    this.heightTexture = createFloatTexture(this.device, 1, 1, new Float32Array([0]));
    this.snowTexture = createFloatTexture(this.device, 1, 1, new Float32Array([0]));
    this.shadowTexture = createFloatTexture(this.device, 1, 1, new Float32Array([0]));
    this.slopeTexture = createRampTexture(this.device, 256);
    this.altitudeTexture = createRampTexture(this.device, 512);
    this.sunlightMapTexture = createRgbaTexture(this.device, 1, 1, new Uint8Array([0, 0, 0, 0]));
    this.blitSampler = createRampSampler(this.device, 'linear');
    this.slopeSampler = createRampSampler(this.device, 'linear');
    this.altitudeSampler = createRampSampler(this.device, 'linear');

    this.rebuildBindGroups();
    this.resize(canvas.width, canvas.height);
  }

  /** Coût GPU lissé des passes de dessin par image, en ms (0 avant la première mesure), voir `GpuFrameTimer`. */
  getGpuFrameMs(): number {
    return this.gpuTimer?.getFrameMs() ?? 0;
  }

  /** Coût GPU lissé de la passe d'ombrage des points par image, en ms (0 avant la première mesure). */
  getGpuShadeMs(): number {
    return this.gpuTimer?.getShadeMs() ?? 0;
  }

  /** Faux quand le coût d'une image n'est qu'approché (pas de `timestamp-query`) : il inclut les attentes de présentation. */
  hasPreciseGpuTiming(): boolean {
    return this.gpuTimer?.usesTimestamps ?? false;
  }

  getLastRenderStats(): { drawCalls: number; outOfMemory: number; terrainTriangles: number } {
    return {
      drawCalls: this.lastDrawCallCount,
      outOfMemory: this.nodePool?.outOfMemoryCount ?? 0,
      terrainTriangles: this.terrain && this.terrainVisible ? this.terrain.lastTriangles : 0,
    };
  }

  /** Nombre maximal de nœuds LOD que le pool GPU peut contenir à la fois (emplacements d'uniforms). */
  getNodeCapacity(): number {
    return this.nodePool?.capacity ?? 0;
  }

  get msaaSamples(): number {
    return this.sampleCount;
  }

  /**
   * Coupe le MSAA (premier pas de la dégradation automatique de qualité sur
   * un GPU qui reste trop lent au budget de points minimal). Se résout à
   * false s'il était déjà coupé.
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
   * Eye-Dome Lighting : `strength` ≈ 1 correspond aux valeurs par défaut de
   * CloudCompare/Potree, `radiusPx` est en pixels de l'écran (à mettre à
   * l'échelle avec le rapport de pixels du canvas).
   */
  /**
   * Vue à hauteur d'œil : des retours situés à quelques mètres se
   * projetteraient en disques de plus de 50 px (un point de 30 cm à 3 m) ;
   * ils sont plafonnés et le maillage du terrain dessiné derrière eux comble
   * le sol entre deux, comme l'œil voit une surface.
   */
  setEyeLevelPoints(enabled: boolean): void {
    this.maxPointPixels = enabled ? EYE_LEVEL_POINT_MAX_PX : POINT_MAX_PX;
  }

  setEdl(enabled: boolean, strength: number, radiusPx: number): void {
    this.edlEnabled = enabled;
    this.edlStrength = Math.max(0, strength);
    this.edlRadiusPx = Math.max(1, radiusPx);
  }

  setColorMode(mode: PointColorMode): void {
    if (mode === this.shading.colorMode) return;
    this.shading.colorMode = mode;
    this.invalidateShading();
  }

  getColorMode(): PointColorMode {
    return this.shading.colorMode;
  }

  private invalidateShading(): void {
    this.nodePool?.invalidateShading();
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
    this.shading.setHeightmapFrame(params);

    const w = params.width;
    const h = params.height;
    this.heightTexture.destroy();
    this.heightTexture = createFloatTexture(this.device, w, h, flipRows(params.data, w, h));
    this.rebuildBindGroups();
  }

  setSnow(params: SnowParams) {
    this.snowTexture.destroy();
    this.snowTexture = createFloatTexture(this.device, params.width, params.height, params.data);
    this.shading.setSnowFrame(params);
    this.rebuildBindGroups();
  }

  setSnowMode(mode: 0 | 1 | 2) {
    if (this.shading.snowMode !== mode) this.invalidateShading();
    this.shading.snowMode = mode;
  }

  setSlopeState(state: ViewerSlopeState): void {
    if (!this.device || this.deviceLost) return;
    const desiredFilter = this.shading.applySlope(state);

    if (state.bands && state.bands.length > 0) {
      writeRampTexture(this.device, this.slopeTexture, buildSlopeRampData(state.bands, state.colorization, 256), 256);
    }

    if (this.slopeFilter !== desiredFilter) {
      this.slopeFilter = desiredFilter;
      this.slopeSampler = createRampSampler(this.device, desiredFilter);
      this.rebuildBindGroups();
    }
    this.invalidateShading();
  }

  setAltitudeState(state: ViewerAltitudeState): void {
    if (!this.device || this.deviceLost) return;
    const desiredFilter = this.shading.applyAltitude(state);

    if (state.bands && state.bands.length > 0) {
      const data = buildAltitudeRampData(state.bands, state.colorization, this.shading.maxAltitude, 512);
      writeRampTexture(this.device, this.altitudeTexture, data, 512);
    }

    if (this.altitudeFilter !== desiredFilter) {
      this.altitudeFilter = desiredFilter;
      this.altitudeSampler = createRampSampler(this.device, desiredFilter);
      this.rebuildBindGroups();
    }
    this.invalidateShading();
  }

  setMaxAltitude(maxAltitude: number): void {
    this.shading.maxAltitude = maxAltitude;
    this.invalidateShading();
  }

  setSunlightRenderState(renderState: SolarRenderState): void {
    if (!this.device || this.deviceLost) return;
    this.shading.applySunlight(renderState);

    let needsRebind = false;

    if (renderState.shadowMapData && renderState.shadowMapWidth > 0 && renderState.shadowMapHeight > 0) {
      const sw = renderState.shadowMapWidth;
      const sh = renderState.shadowMapHeight;
      this.shadowTexture.destroy();
      this.shadowTexture = createFloatTexture(this.device, sw, sh, unitFloatsFromBytes(renderState.shadowMapData, sw * sh));
      needsRebind = true;
    }

    if (renderState.sunlightMapRgba && renderState.sunlightMapWidth > 0 && renderState.sunlightMapHeight > 0) {
      const mw = renderState.sunlightMapWidth;
      const mh = renderState.sunlightMapHeight;
      this.sunlightMapTexture.destroy();
      this.sunlightMapTexture = createRgbaTexture(this.device, mw, mh, renderState.sunlightMapRgba);
      needsRebind = true;
    }

    if (needsRebind) this.rebuildBindGroups();

    if (renderState.trajectoryVertices && renderState.trajectoryVertexCount > 0) {
      this.trajectoryBuffer?.destroy();
      this.trajectoryBuffer = createVertexBuffer(this.device, renderState.trajectoryVertices);
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

    destroySceneTargets(this.fullTargets);
    destroySceneTargets(this.motionTargets);
    const config = {
      device: this.device,
      pipelines: this.pipelines,
      format: this.format,
      sampleCount: this.sampleCount,
      edlParamsBuffer: this.edlParamsBuffer,
      blitSampler: this.blitSampler,
    };
    this.fullTargets = createSceneTargets(config, this.canvasWidth, this.canvasHeight);
    this.accumTexture?.destroy();
    this.accumTexture = this.device.createTexture({
      size: [this.canvasWidth, this.canvasHeight],
      format: ACCUMULATION_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.accumView = this.accumTexture.createView();
    this.presentBindGroup = this.device.createBindGroup({
      layout: this.pipelines.presentBindGroupLayout,
      entries: [{ binding: 0, resource: this.accumView }],
    });
    this.motionTargets = this.motionScale < 1
      ? createSceneTargets(
        config,
        Math.max(1, Math.round(this.canvasWidth * this.motionScale)),
        Math.max(1, Math.round(this.canvasHeight * this.motionScale)),
      )
      : null;
  }

  /** Tiles' DTM grids (merged vertex buffers), see `TerrainLod`. */
  setTerrainMesh(mesh: TerrainMeshData): void {
    this.terrain?.destroy();
    this.terrain = new TerrainLod(this.device, mesh, this.pipelines.terrainLodBindGroupLayout);
  }

  setPreviewMesh(
    meshOrVertices: { vertices: Float32Array; colors: Uint8Array; indices: Uint32Array; count: number } | Float32Array,
    colors?: Uint8Array,
    indices?: Uint32Array,
  ) {
    if (meshOrVertices instanceof Float32Array) {
      if (!colors || !indices) return;
      this.clearPreviewMesh();
      this.previewMesh = createMeshBuffers(this.device, meshOrVertices, colors, indices, indices.length);
      return;
    }
    this.clearPreviewMesh();
    this.previewMesh = createMeshBuffers(this.device, 
      meshOrVertices.vertices,
      meshOrVertices.colors,
      meshOrVertices.indices,
      meshOrVertices.count,
    );
  }

  clearPreviewMesh(): void {
    destroyMeshBuffers(this.previewMesh);
    this.previewMesh = null;
  }

  setRouteMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void {
    this.clearRouteMesh();
    if (!this.device || vertices.length === 0 || indices.length === 0) return;
    this.routeMesh = createMeshBuffers(this.device, vertices, colors, indices, count ?? indices.length);
  }

  setPointFilterState(state: ViewerPointFilterState): void {
    this.shading.applyPointFilter(state);
  }

  clearRouteMesh(): void {
    destroyMeshBuffers(this.routeMesh);
    this.routeMesh = null;
  }

  /** Triangles colorés translucides dans le repère de rendu, dessinés comme le tracé (sans écriture de profondeur). */
  setAnalysisMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    this.clearAnalysisMesh();
    if (!this.device || vertices.length === 0 || indices.length === 0) return;
    this.analysisMesh = createMeshBuffers(this.device, vertices, colors, indices, indices.length);
  }

  clearAnalysisMesh(): void {
    destroyMeshBuffers(this.analysisMesh);
    this.analysisMesh = null;
  }

  /**
   * Décalage sous-pixel (px du canvas) appliqué à la projection des prochains
   * appels à `updateCamera`, pour les images fixes accumulées ; (0, 0) sinon.
   * La sélection du LOD, l'élimination et le picking gardent les matrices non
   * décalées.
   */
  setSubpixelJitter(x: number, y: number): void {
    this.jitterX = x;
    this.jitterY = y;
  }

  /** Z inversé avec un plan lointain à l'infini : la précision de profondeur n'a pas besoin ici d'une plage proche/lointain. */
  setDepthRange(_near: number, _far: number): void {}

  /**
   * @param projMat projection de rendu (Z inversé, plan lointain à l'infini :
   *   voir `CameraController.getRenderProjMatrix`). Sa ligne 3 est celle de la
   *   projection standard, donc les tailles écran du LOD et l'élimination par
   *   frustum ne changent pas.
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

    const pos = camPos && camPos.length >= 3 ? vec3Of(camPos) : cameraPositionFromView(vArr);
    this.lastCamPos = pos;
    this.lastCamFwd = camFwd && camFwd.length >= 3 ? vec3Of(camFwd) : cameraForwardFromView(vArr);

    mat4MultiplyInto(this._cachedViewProj, pArr, vArr);
    this.lastViewProj.set(this._cachedViewProj);
    let drawViewProj = this._cachedViewProj;
    if (this.jitterX !== 0 || this.jitterY !== 0) {
      // Décalage dans l'espace de découpage de (dx, dy)·w : toute l'image se déplace du décalage en pixels.
      const vp = this.jitteredViewProj;
      vp.set(this._cachedViewProj);
      const dx = (2 * this.jitterX) / this.canvasWidth;
      const dy = (2 * this.jitterY) / this.canvasHeight;
      for (let col = 0; col < 4; col++) {
        vp[col * 4] = vp[col * 4]! + dx * vp[col * 4 + 3]!;
        vp[col * 4 + 1] = vp[col * 4 + 1]! + dy * vp[col * 4 + 3]!;
      }
      drawViewProj = vp;
    }
    this.drawViewProj.set(drawViewProj);
    const photoActive = this.photoRenderer?.active ?? false;
    if (photoActive !== this.photoShading) {
      // La passe d'ombrage écrit des couleurs éclairées, ou l'albédo en mode photo.
      this.photoShading = photoActive;
      this.invalidateShading();
    }
    packSceneUniforms(this.uniformCache, this.uniformCacheU32, drawViewProj, vArr, pos, this.shading.uniformState({
      pointSize: this.pointSize,
      canvasWidth: this.canvasWidth,
      canvasHeight: this.canvasHeight,
      density,
      centerAltitude: this.centerAltitude,
      photoMode: photoActive ? 1 : 0,
    }));
    this.device.queue.writeBuffer(this.cameraBuffer, 0, this.uniformCache as Float32Array<ArrayBuffer>);
  }

  /** Paramètres de sprite et d'EDL de l'image pour des cibles de scène de `width`×`height` (`scale` du canvas). */
  private writeFrameParams(width: number, height: number, scale: number): void {
    fillPointParams(this.pointParams, width, height, scale, {
      maxPointPixels: this.maxPointPixels,
      fixedPointPixels: this.fixedPointPixels,
      projScaleY: this.lastProjScaleY,
      pointSize: this.pointSize,
      adaptivePointSize: this.adaptivePointSize,
      pointSizeReference: this.pointSizeReference,
      msaa: this.sampleCount > 1,
    });
    this.device.queue.writeBuffer(this.pointParamsBuffer, 0, this.pointParams as Float32Array<ArrayBuffer>);

    fillEdlParams(this.edlParams, { enabled: this.edlEnabled, strength: this.edlStrength, radiusPx: this.edlRadiusPx }, scale);
    this.device.queue.writeBuffer(this.edlParamsBuffer, 0, this.edlParams as Float32Array<ArrayBuffer>);
  }

  /** Part de la résolution du canvas à laquelle la dernière image a été rendue. */
  getLastRenderScale(): number {
    return this.lastRenderScale;
  }

  /**
   * Rend le terrain, les nœuds LOD donnés (de l'avant vers l'arrière) et les
   * superpositions.
   * `motion` : la caméra bouge — résolution réduite (`motionScale`) et sprites
   * carrés ; la prochaine image fixe rétablit la pleine qualité.
   * `accumulate` : indice d'une image fixe de l'anticrénelage progressif (0
   * relance la moyenne glissante) ; fixer le décalage sous-pixel de l'image
   * avant `updateCamera`.
   */
  renderScene(nodes: readonly SceneNode[], options: RenderSceneOptions = {}): void {
    if (!this.device || this.deviceLost || !this.fullTargets || !this.nodePool) return;
    if (this.photoRenderer?.active) {
      this.renderPhoto(nodes, options);
      return;
    }

    const canvasView = this.context.getCurrentTexture().createView();
    this.lastDrawCallCount = 0;
    const reduced = options.motion === true && this.motionTargets !== null;
    const accumulateSample = !reduced && options.accumulate !== undefined && this.accumView && this.presentBindGroup
      ? options.accumulate
      : -1;
    const targets = reduced ? this.motionTargets! : this.fullTargets;
    const scale = targets.width / this.canvasWidth;
    this.lastRenderScale = scale;
    this.writeFrameParams(targets.width, targets.height, scale);

    const [clearR, clearG, clearB] = this.shading.clearColor();

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
    // En pleine résolution sans EDL, la scène va directement dans le canvas
    // (résolue là avec le MSAA) : aucune copie plein écran. La profondeur n'est
    // stockée que pour l'EDL.
    const direct = !this.edlEnabled && !reduced && accumulateSample < 0;
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

    // Les points d'abord (de l'avant vers l'arrière), puis le terrain ne remplit que ce qui reste.
    pass.setPipeline(options.motion && this.motionSquares ? this.pipelines.pointPipelineSquare : this.pipelines.pointPipeline);
    pass.setBindGroup(1, this.pointParamsBindGroup);
    this.lastDrawCallCount += this.nodePool.draw(pass, nodes);

    if (this.terrain && this.terrainVisible) {
      // Niveaux choisis à la résolution du canvas, comme les points.
      const focalPx = Math.abs(this.lastProjScaleY) * this.canvasHeight * 0.5;
      this.lastDrawCallCount += this.terrain.draw(pass, this.pipelines.terrainLodPipeline, this.lastViewProj, this.lastCamPos, focalPx);
    }

    if (this.previewMesh) {
      drawMesh(pass, this.pipelines.previewPipeline, this.previewMesh);
      this.lastDrawCallCount += 1;
    }

    if (this.shading.trajectoryEnabled && this.trajectoryVertexCount > 1 && this.trajectoryBuffer) {
      pass.setPipeline(this.pipelines.trajectoryPipeline);
      pass.setVertexBuffer(0, this.trajectoryBuffer);
      pass.draw(this.trajectoryVertexCount, 1, 0, 0);
      this.lastDrawCallCount += 1;
    }

    if (this.shading.trajectoryEnabled && this.shading.sunDiscPos) {
      pass.setPipeline(this.pipelines.sunDiscPipeline);
      pass.draw(6, 1, 0, 0);
      this.lastDrawCallCount += 1;
    }

    if (this.analysisMesh && this.analysisMesh.count > 0) {
      pass.setPipeline(this.pipelines.routePipeline);
      pass.setVertexBuffer(0, this.analysisMesh.vertBuf);
      pass.setVertexBuffer(1, this.analysisMesh.colBuf);
      pass.setIndexBuffer(this.analysisMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.analysisMesh.count);
      this.lastDrawCallCount += 1;
    }

    if (this.routeMesh && this.routeMesh.count > 0) {
      drawMesh(pass, this.pipelines.routePipeline, this.routeMesh);
      this.lastDrawCallCount += 1;
    }
    pass.end();

    if (accumulateSample >= 0) {
      // EDL (ou une simple copie) en lumière linéaire, fondue dans la moyenne
      // glissante : poids 1 / (n + 1), le premier échantillon remplace l'historique.
      const resolve = enc.beginRenderPass({
        colorAttachments: [{
          view: this.accumView!,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: accumulateSample === 0 ? 'clear' : 'load',
          storeOp: 'store',
        }],
        timestampWrites: timed ? this.gpuTimer!.passTimestamps(TIMED_PASS.edl) : undefined,
      });
      const weight = 1 / (accumulateSample + 1);
      resolve.setPipeline(this.pipelines.accumulatePipeline);
      resolve.setBindGroup(0, targets.edlBindGroup);
      resolve.setBlendConstant({ r: weight, g: weight, b: weight, a: weight });
      resolve.draw(3);
      resolve.end();

      const present = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: clearR, g: clearG, b: clearB, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      present.setPipeline(this.pipelines.presentPipeline);
      present.setBindGroup(0, this.presentBindGroup!);
      present.draw(3);
      present.end();
    } else if (!direct) {
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

  /** Image du mode photo : la passe d'ombrage (albédo), puis les passes du renderer photo. */
  private renderPhoto(nodes: readonly SceneNode[], options: RenderSceneOptions): void {
    const photo = this.photoRenderer!;
    const nodePool = this.nodePool!;
    const canvasView = this.context.getCurrentTexture().createView();
    const enc = this.device.createCommandEncoder();
    const timed = this.gpuTimer?.beginFrame() ?? false;
    const reuseScene = options.reuseScene === true;
    if (!reuseScene) {
      nodePool.prepareFrame(
        enc,
        this.pipelines.shadingPipeline,
        this.sceneBindGroup,
        nodes,
        timed ? () => this.gpuTimer!.passTimestamps(TIMED_PASS.shading) : undefined,
      );
    }
    const accumulate = options.accumulate ?? -1;
    this.lastDrawCallCount = photo.render({
      encoder: enc,
      canvasView,
      canvasWidth: this.canvasWidth,
      canvasHeight: this.canvasHeight,
      motion: options.motion === true,
      squares: this.motionSquares,
      motionScale: this.motionScale,
      accumulate: options.motion ? -1 : accumulate,
      reuseScene,
      nodes,
      drawViewProj: this.drawViewProj,
      viewProj: this.lastViewProj,
      camPos: this.lastCamPos,
      sceneBindGroup: this.sceneBindGroup,
      pointParamsBindGroup: this.pointParamsBindGroup,
      terrain: this.terrain,
      terrainVisible: this.terrainVisible,
      overlays: { preview: this.previewMesh, route: this.routeMesh, analysis: this.analysisMesh },
      heightTexture: this.heightTexture,
      heightmap: [this.shading.hmOriginX, this.shading.hmOriginZ, this.shading.hmScaleX, this.shading.hmScaleZ],
      pointSizeM: this.pointSize,
      pointFilter: { enabled: this.shading.pointFilterEnabled > 0.5, mask: this.shading.pointFilterMask },
      writePointParams: (width, height, scale) => this.writeFrameParams(width, height, scale),
      timed,
    });
    this.lastRenderScale = options.motion && this.motionScale < 1 ? this.motionScale : 1;
    if (timed) this.gpuTimer!.encodeResolve(enc);
    this.device.queue.submit([enc.finish()]);
    this.gpuTimer?.afterSubmit();
    photo.afterSubmit();
  }

  destroy(): void {
    this.photoRenderer?.destroy();
    this.photoRenderer = null;
    this.gpuTimer?.destroy();
    this.gpuTimer = null;
    this.terrain?.destroy();
    this.terrain = null;
    this.clearPreviewMesh();
    this.clearRouteMesh();
    this.clearAnalysisMesh();
    this.trajectoryBuffer?.destroy();
    this.trajectoryBuffer = null;
    this.nodePool?.destroy();
    this.nodePool = null;

    this.cameraBuffer?.destroy();
    this.pointParamsBuffer?.destroy();
    this.edlParamsBuffer?.destroy();
    destroySceneTargets(this.fullTargets);
    destroySceneTargets(this.motionTargets);
    this.fullTargets = null;
    this.motionTargets = null;
    this.accumTexture?.destroy();
    this.accumTexture = null;
    this.accumView = null;
    this.presentBindGroup = null;
    this.heightTexture?.destroy();
    this.snowTexture?.destroy();
    this.slopeTexture?.destroy();
    this.altitudeTexture?.destroy();
    this.shadowTexture?.destroy();
    this.sunlightMapTexture?.destroy();
    this.device?.destroy();
  }
}
