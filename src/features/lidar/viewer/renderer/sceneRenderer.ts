// ============================================
// Scene renderer contract, implemented by the WebGPU and WebGL 2 backends
// ============================================
//
// The viewer (LOD streaming, tools, comments, route editing, overlays)
// only talks to this interface. `WebGpuLidarRenderer` (renderer.ts) is the
// reference; `WebGlLidarRenderer` (webgl/glRenderer.ts) draws the same
// frame with WebGL 2 where WebGPU is missing — Firefox and most Chrome
// builds on Linux, blocklisted drivers — with the same shading, LOD, EDL
// and progressive anti-aliasing. `createLidarRenderer` picks the backend.

import type { PlatformProfile } from '../lod/types';
import type { SceneNode, SceneNodeUploader } from '../lod/sceneLod';
import type { ViewerAltitudeState, ViewerSlopeState } from '../rightPanel/types';
import type { ViewerPointFilterState } from '../pointFilter';
import type { SolarRenderState } from '../../viewer-webgl/sunlightController';
import type { HeightmapParams, SnowParams } from './types';
import type { TerrainMeshData } from './terrainLodCore';

type RendererBackend = 'webgpu' | 'webgl';

/** Point colouring: orthophoto/embedded RGB, uniform grey (relief only), LiDAR intensity, or classification. */
export type PointColorMode = 'rgb' | 'grey' | 'intensity' | 'classification';

/** Shader index of each colour mode (scene uniform `colorMode`). */
export const COLOR_MODE_INDEX: Record<PointColorMode, number> = { rgb: 0, intensity: 1, classification: 2, grey: 3 };

/** Why the GPU context went away (WebGPU device lost, WebGL context lost). */
export interface RendererLostInfo {
  reason: string;
  message: string;
}

export interface RenderSceneOptions {
  /** The camera is moving: reduced resolution (`motionScale`) and square sprites. */
  motion?: boolean;
  /** Index of a still frame of the progressive anti-aliasing (0 restarts the running mean). */
  accumulate?: number;
}

export interface RenderStats {
  drawCalls: number;
  outOfMemory: number;
  terrainTriangles: number;
}

export interface LidarRenderer extends SceneNodeUploader {
  readonly backend: RendererBackend;
  /** Canvas drawn on: a canvas keeps its first context type, so a fallback backend gets a fresh element. */
  readonly canvas: HTMLCanvasElement;
  readonly platform: PlatformProfile | null;
  /** Called once when the GPU context is lost for any reason other than `destroy()`. */
  onDeviceLost: ((info: RendererLostInfo) => void) | null;

  /** Scene resolution while the camera moves, as a share of the canvas (1 = off). Set before `resize`. */
  motionScale: number;
  /** Square sprites (no discard) while the camera moves. */
  motionSquares: boolean;
  centerAltitude: number;
  /** Point diameter in metres, identical for every point (projected, clamped in pixels). */
  pointSize: number;
  /** Default `pointSize` of the scene; the adaptive size follows the user's changes to it. */
  pointSizeReference: number;
  /** Point diameter in device pixels; 0 = adaptive (world size, clamped in pixels). */
  fixedPointPixels: number;
  /** Coarser LOD levels drawn as the finest on screen grow to their own spacing. */
  adaptivePointSize: boolean;
  terrainVisible: boolean;

  /** View-projection of the last `updateCamera` (unjittered; LOD selection and culling). */
  readonly lastViewProj: Float32Array;
  readonly lastCamPos: Float32Array | [number, number, number];
  /** proj[1][1] of the last camera update (LOD screen-size focal). */
  readonly lastProjScaleY: number;

  resize(width: number, height: number): void;
  /**
   * Near/far distances of the current view. The WebGPU backend renders with
   * reversed-Z and an infinite far plane and ignores them; WebGL 2 has no
   * standard clip control (absent from Firefox), so it builds a finite
   * projection from them.
   */
  setDepthRange(near: number, far: number): void;
  /** @param projMat reversed-Z, infinite-far render projection (`CameraController.getRenderProjMatrix`). */
  updateCamera(viewMat: Float32Array, projMat: Float32Array, camPos: [number, number, number] | Float32Array): void;
  /** Sub-pixel offset (canvas px) of the next `updateCamera` calls, for the accumulated still frames. */
  setSubpixelJitter(x: number, y: number): void;
  setEyeLevelPoints(enabled: boolean): void;
  /** Renders the terrain, the given LOD nodes (front to back) and the overlays. */
  renderScene(nodes: readonly SceneNode[], options?: RenderSceneOptions): void;

  setEdl(enabled: boolean, strength: number, radiusPx: number): void;
  setColorMode(mode: PointColorMode): void;
  setHeightmap(params: HeightmapParams): void;
  setTerrainMesh(mesh: TerrainMeshData): void;
  setMaxAltitude(maxAltitude: number): void;
  setSnow(params: SnowParams): void;
  setSnowMode(mode: 0 | 1 | 2): void;
  setSlopeState(state: ViewerSlopeState): void;
  setAltitudeState(state: ViewerAltitudeState): void;
  setSunlightRenderState(renderState: SolarRenderState): void;
  setPointFilterState(state: ViewerPointFilterState): void;
  setPreviewMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void;
  clearPreviewMesh(): void;
  setRouteMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array, count?: number): void;
  clearRouteMesh(): void;
  /** Translucent coloured triangles in the render frame, drawn like the route (no depth write). */
  setAnalysisMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void;
  clearAnalysisMesh(): void;

  /** Drops MSAA (first step of the automatic quality downgrade); false when it was already off. */
  disableMsaa(): Promise<boolean>;
  /** Max LOD nodes the GPU pool can hold at once. */
  getNodeCapacity(): number;
  /** Smoothed GPU cost of the draw passes per frame in ms (0 until measured). */
  getGpuFrameMs(): number;
  /** Smoothed GPU cost of the point shading pass per frame in ms (0 until measured). */
  getGpuShadeMs(): number;
  /** False when frame cost is not measured on the GPU (no timestamp / timer queries). */
  hasPreciseGpuTiming(): boolean;
  getLastRenderStats(): RenderStats;
  /** Share of the canvas resolution the last frame was rendered at. */
  getLastRenderScale(): number;
  destroy(): void;
}
