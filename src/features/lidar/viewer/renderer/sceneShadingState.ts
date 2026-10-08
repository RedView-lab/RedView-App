import { DEFAULT_MAX_ALTITUDE_M } from '../altitude/altitudeRamp';
import { computePointFilterBitmasks, type ViewerPointFilterState } from '../pointFilter';
import type { ViewerAltitudeState, ViewerSlopeState } from '../rightPanel/types';
import type { SolarRenderState } from '../../viewer-webgl/sunlightController';
import { COLOR_MODE_INDEX, type PointColorMode } from './sceneRenderer';
import type { SceneUniformState } from './sceneUniforms';

/** Bornes du diamètre projeté des points (pixels physiques) pour le mode en mètres. */
const POINT_MIN_PX = 1.0;
export const POINT_MAX_PX = 64;
/** Plafond du diamètre des points en vue à hauteur d'œil (première personne), px physiques. */
export const EYE_LEVEL_POINT_MAX_PX = 14;
/**
 * Taille adaptative des points les plus fins à l'écran, par mètre d'espacement
 * en surface de leur nœud : les mêmes 1,5 × espacement que la taille de point
 * par défaut donne aux points en pleine densité (voir `pointSizeReference`).
 */
const ADAPTIVE_SPACING_FACTOR = 1.5;
/** Emplacements d'uniform du pool de nœuds (un par nœud LOD résident). */
export const NODE_POOL_CAPACITY = 16384;

/** Filtrage de la rampe de couleurs d'une surcouche : dégradé continu, ou paliers francs entre bandes. */
export type RampFilter = 'linear' | 'nearest';

/**
 * État de surcouche et d'éclairage partagé par les renderers WebGPU et WebGL 2 :
 * écrit par les setters du viewer, empaqueté dans le bloc d'uniforms `Scene`
 * (`packSceneUniforms`). Les ressources GPU (textures, samplers) restent dans
 * chaque backend ; ceci ne contient que ce que les deux lisent de la même façon.
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

  /** Placement de la grille du MNT dans le repère de rendu. */
  setHeightmapFrame(params: { originX: number; originZ: number; scaleX: number; scaleZ: number }): void {
    this.hmOriginX = params.originX;
    this.hmOriginZ = params.originZ;
    this.hmScaleX = params.scaleX;
    this.hmScaleZ = params.scaleZ;
  }

  /** Placement de la grille de neige dans le repère de rendu. */
  setSnowFrame(params: { originX: number; originZ: number; scaleX: number; scaleZ: number }): void {
    this.snowOriginX = params.originX;
    this.snowOriginZ = params.originZ;
    this.snowScaleX = params.scaleX;
    this.snowScaleZ = params.scaleZ;
  }

  /** Visibilité et opacité de la surcouche des pentes ; renvoie le filtre de rampe que demande la colorisation. */
  applySlope(state: ViewerSlopeState): RampFilter {
    this.slopeEnabled = state.enabled ? 1 : 0;
    this.slopeOpacity = (state.opacity ?? 50) / 100;
    return state.colorization === 'stepped' ? 'nearest' : 'linear';
  }

  /** Visibilité et opacité de la surcouche d'altitude ; renvoie le filtre de rampe que demande la colorisation. */
  applyAltitude(state: ViewerAltitudeState): RampFilter {
    this.altitudeEnabled = state.enabled ? 1 : 0;
    this.altitudeOpacity = (state.opacity ?? 50) / 100;
    return state.colorization === 'stepped' ? 'nearest' : 'linear';
  }

  /** Partie scalaire de l'état d'ensoleillement (les cartes d'ombre et d'ensoleillement sont des textures de chaque backend). */
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

  /** Fond de la scène : la couleur du ciel avec l'ensoleillement activé, sinon le bleu clair du viewer. */
  clearColor(): [number, number, number] {
    return this.sunlightEnabled
      ? [this.skyColor[0], this.skyColor[1], this.skyColor[2]]
      : [0.76, 0.87, 0.96];
  }

  /** Contenu du bloc d'uniforms `Scene` pour cette image. */
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

/** Dimensionnement des sprites des passes de points, partagé par les deux backends (disposition du bloc `PointParams`). */
export interface PointSizing {
  maxPointPixels: number;
  fixedPointPixels: number;
  /** proj[1][1] de la dernière mise à jour de caméra. */
  projScaleY: number;
  pointSize: number;
  adaptivePointSize: boolean;
  pointSizeReference: number;
  msaa: boolean;
}

/** Remplit le bloc `PointParams` pour des cibles de scène de `width`×`height` (`scale` du canvas). */
export function fillPointParams(p: Float32Array, width: number, height: number, scale: number, s: PointSizing): void {
  // Les tailles en pixels suivent la cible : l'image agrandie garde les mêmes tailles de points.
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

/** Remplit les paramètres de l'EDL (force, rayon en px de la cible, activé, échelle). */
export function fillEdlParams(e: Float32Array, edl: { enabled: boolean; strength: number; radiusPx: number }, scale: number): void {
  e[0] = edl.strength;
  e[1] = Math.max(1, edl.radiusPx * scale);
  e[2] = edl.enabled ? 1 : 0;
  e[3] = scale;
}
