import { DEFAULT_MAX_ALTITUDE_M } from '../altitude/altitudeRamp';
import { computePointFilterBitmasks, type ViewerPointFilterState } from '../pointFilter';
import type { ViewerAltitudeState, ViewerSlopeState } from '../rightPanel/types';
import type { SolarRenderState } from '../../viewer-webgl/sunlightController';
import { COLOR_MODE_INDEX, type PointColorMode } from './sceneRenderer';
import type { SceneUniformState } from './sceneUniforms';

/** Projected point diameter bounds (device pixels) for the metre-sized mode. */
const POINT_MIN_PX = 1.0;
export const POINT_MAX_PX = 64;
/** Point diameter cap of the eye-level (first-person) view, device px. */
export const EYE_LEVEL_POINT_MAX_PX = 14;
/**
 * Adaptive size of the finest points on screen, per metre of their node's
 * surface spacing: the same 1.5 × spacing the default point size gives the
 * full-density points (see `pointSizeReference`).
 */
const ADAPTIVE_SPACING_FACTOR = 1.5;
/** Uniform slots of the node pool (one per resident LOD node). */
export const NODE_POOL_CAPACITY = 16384;

/** Filtering of an overlay colour ramp: smooth gradient, or hard steps between bands. */
export type RampFilter = 'linear' | 'nearest';

/**
 * Overlay and lighting state shared by the WebGPU and WebGL 2 renderers:
 * written by the viewer's setters, packed into the `Scene` uniform block
 * (`packSceneUniforms`). The GPU resources (textures, samplers) stay in each
 * backend; this holds only what both read the same way.
 */
export class SceneShadingState {
  hmOriginX = 0;
  hmOriginZ = 0;
  hmScaleX = 1;
  hmScaleZ = 1;

  snowMode: 0 | 1 | 2 = 0;
  snowOriginX = 0;
  snowOriginZ = 0;
  snowScaleX = 1;
  snowScaleZ = 1;

  slopeEnabled = 0;
  slopeOpacity = 0.5;
  altitudeEnabled = 0;
  altitudeOpacity = 0.5;
  maxAltitude = DEFAULT_MAX_ALTITUDE_M;

  shadowEnabled = 0;
  shadowOpacity = 0.5;
  sunlightEnabled = 0;
  sunlightMapEnabled = 0;
  sunlightMapOpacity = 0.5;
  sunIntensity = 1.0;
  exposure = 1.0;
  sunDir: [number, number, number] = [0.28, 0.78, 0.55];
  sunColor: [number, number, number] = [1.0, 0.98, 0.95];
  skyColor: [number, number, number] = [0.65, 0.75, 0.85];
  sunDiscPos: [number, number, number] | null = null;
  sunDiscRadius = 0;
  trajectoryEnabled = false;

  pointFilterEnabled = 0;
  pointFilterMask: [number, number, number, number] = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
  colorMode: PointColorMode = 'rgb';

  /** Placement of the DTM grid in the render frame. */
  setHeightmapFrame(params: { originX: number; originZ: number; scaleX: number; scaleZ: number }): void {
    this.hmOriginX = params.originX;
    this.hmOriginZ = params.originZ;
    this.hmScaleX = params.scaleX;
    this.hmScaleZ = params.scaleZ;
  }

  /** Placement of the snow grid in the render frame. */
  setSnowFrame(params: { originX: number; originZ: number; scaleX: number; scaleZ: number }): void {
    this.snowOriginX = params.originX;
    this.snowOriginZ = params.originZ;
    this.snowScaleX = params.scaleX;
    this.snowScaleZ = params.scaleZ;
  }

  /** Visibility and opacity of the slope overlay; returns the ramp filter the colorization asks for. */
  applySlope(state: ViewerSlopeState): RampFilter {
    this.slopeEnabled = state.enabled ? 1 : 0;
    this.slopeOpacity = (state.opacity ?? 50) / 100;
    return state.colorization === 'stepped' ? 'nearest' : 'linear';
  }

  /** Visibility and opacity of the altitude overlay; returns the ramp filter the colorization asks for. */
  applyAltitude(state: ViewerAltitudeState): RampFilter {
    this.altitudeEnabled = state.enabled ? 1 : 0;
    this.altitudeOpacity = (state.opacity ?? 50) / 100;
    return state.colorization === 'stepped' ? 'nearest' : 'linear';
  }

  /** Scalar part of the sunlight state (the shadow and sunlight maps are textures of each backend). */
  applySunlight(renderState: SolarRenderState): void {
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
    this.trajectoryEnabled = renderState.trajectoryEnabled;
    this.sunDiscPos = renderState.sunDiscPos;
    this.sunDiscRadius = renderState.sunDiscRadius;
  }

  applyPointFilter(state: ViewerPointFilterState): void {
    this.pointFilterEnabled = state.enabled ? 1.0 : 0.0;
    this.pointFilterMask = computePointFilterBitmasks(state.enabled, state.categories);
  }

  /** Background of the scene: the sky colour with sunlight on, else the viewer's light blue. */
  clearColor(): [number, number, number] {
    return this.sunlightEnabled
      ? [this.skyColor[0], this.skyColor[1], this.skyColor[2]]
      : [0.76, 0.87, 0.96];
  }

  /** The `Scene` uniform block contents for this frame. */
  uniformState(frame: {
    pointSize: number;
    canvasWidth: number;
    canvasHeight: number;
    density: number;
    centerAltitude: number;
    photoMode?: number;
  }): SceneUniformState {
    return {
      pointSize: frame.pointSize,
      canvasWidth: frame.canvasWidth,
      canvasHeight: frame.canvasHeight,
      sunDir: this.sunDir,
      hmOriginX: this.hmOriginX,
      hmOriginZ: this.hmOriginZ,
      hmScaleX: this.hmScaleX,
      hmScaleZ: this.hmScaleZ,
      density: frame.density,
      centerAltitude: frame.centerAltitude,
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
      photoMode: frame.photoMode,
    };
  }
}

/** Sprite sizing of the point passes, shared by both backends (layout of the `PointParams` block). */
export interface PointSizing {
  maxPointPixels: number;
  fixedPointPixels: number;
  /** proj[1][1] of the last camera update. */
  projScaleY: number;
  pointSize: number;
  adaptivePointSize: boolean;
  pointSizeReference: number;
  msaa: boolean;
}

/** Fills the `PointParams` block for scene targets of `width`×`height` (`scale` of the canvas). */
export function fillPointParams(p: Float32Array, width: number, height: number, scale: number, s: PointSizing): void {
  // Pixel sizes follow the target, so the upscaled image keeps the same point sizes.
  p[0] = POINT_MIN_PX;
  p[1] = s.maxPointPixels * scale;
  p[2] = s.fixedPointPixels * scale;
  p[3] = Math.abs(s.projScaleY) * height * 0.5;
  p[4] = width;
  p[5] = height;
  p[6] = s.msaa ? 1 : 0;
  p[7] = s.pointSize;
  p[8] = s.adaptivePointSize
    ? ADAPTIVE_SPACING_FACTOR * (s.pointSizeReference > 0 ? s.pointSize / s.pointSizeReference : 1)
    : 0;
}

/** Fills the EDL parameters (strength, radius in target px, enabled, scale). */
export function fillEdlParams(e: Float32Array, edl: { enabled: boolean; strength: number; radiusPx: number }, scale: number): void {
  e[0] = edl.strength;
  e[1] = Math.max(1, edl.radiusPx * scale);
  e[2] = edl.enabled ? 1 : 0;
  e[3] = scale;
}
