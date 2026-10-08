// ============================================
// Contrat du renderer de scène, implémenté par les backends WebGPU et WebGL 2
// ============================================
//
// Le viewer (flux LOD, outils, commentaires, édition de tracé, surcouches) ne
// parle qu'à cette interface. `WebGpuLidarRenderer` (renderer.ts) est la
// référence ; `WebGlLidarRenderer` (webgl/glRenderer.ts) dessine la même image
// en WebGL 2 là où WebGPU manque — Firefox et la plupart des builds de Chrome
// sous Linux, pilotes en liste noire — avec le même ombrage, LOD, EDL et
// anticrénelage progressif. `createLidarRenderer` choisit le backend.

import type { PlatformProfile } from '../lod/types';
import type { SceneNode, SceneNodeUploader } from '../lod/sceneLod';
import type { ViewerAltitudeState, ViewerSlopeState } from '../rightPanel/types';
import type { ViewerPointFilterState } from '../pointFilter';
import type { SolarRenderState } from '../../viewer-webgl/sunlightController';
import type { HeightmapParams, SnowParams } from './types';
import type { TerrainMeshData } from './terrainLodCore';
import type { PhotoModeRenderer } from '../photoMode/renderer/types';

type RendererBackend = 'webgpu' | 'webgl';

/** Coloration des points : orthophoto/RVB intégré, gris uniforme (relief seul), intensité LiDAR ou classification. */
export type PointColorMode = 'rgb' | 'grey' | 'intensity' | 'classification';

/** Indice shader de chaque mode de couleur (uniform de scène `colorMode`). */
export const COLOR_MODE_INDEX: Record<PointColorMode, number> = { rgb: 0, intensity: 1, classification: 2, grey: 3 };

/** Pourquoi le contexte GPU a disparu (device WebGPU perdu, contexte WebGL perdu). */
export interface RendererLostInfo {
  reason: string;
  message: string;
}

export interface RenderSceneOptions {
  /** La caméra bouge : résolution réduite (`motionScale`) et sprites carrés. */
  motion?: boolean;
  /** Indice d'une image fixe de l'anticrénelage progressif (0 relance la moyenne courante). */
  accumulate?: number;
  /**
   * Mode photo : la vue fixe est déjà accumulée, seul ce qui change de
   * lui-même (nuages qui dérivent et leurs ombres) est redessiné.
   */
  reuseScene?: boolean;
}

export interface RenderStats {
  drawCalls: number;
  outOfMemory: number;
  terrainTriangles: number;
}

export interface LidarRenderer extends SceneNodeUploader {
  readonly backend: RendererBackend;
  /** Canvas de dessin : un canvas garde son premier type de contexte, un backend de repli reçoit donc un élément neuf. */
  readonly canvas: HTMLCanvasElement;
  readonly platform: PlatformProfile | null;
  /** Appelé une fois quand le contexte GPU est perdu pour toute autre raison que `destroy()`. */
  onDeviceLost: ((info: RendererLostInfo) => void) | null;
  /** Mode photo (ciel, nuages, ombres du nuage de points) : WebGPU seulement, null en WebGL 2. */
  readonly photo: PhotoModeRenderer | null;

  /** Résolution de la scène pendant que la caméra bouge, en part du canvas (1 = désactivé). À poser avant `resize`. */
  motionScale: number;
  /** Sprites carrés (sans discard) pendant que la caméra bouge. */
  motionSquares: boolean;
  centerAltitude: number;
  /** Diamètre des points en mètres, identique pour tous les points (projeté, borné en pixels). */
  pointSize: number;
  /** `pointSize` par défaut de la scène ; la taille adaptative suit les changements que l'utilisateur y apporte. */
  pointSizeReference: number;
  /** Diamètre des points en pixels physiques ; 0 = adaptatif (taille monde, bornée en pixels). */
  fixedPointPixels: number;
  /** Les niveaux LOD plus grossiers dessinés comme les plus fins à l'écran grossissent jusqu'à leur propre espacement. */
  adaptivePointSize: boolean;
  terrainVisible: boolean;

  /** View-projection du dernier `updateCamera` (sans jitter ; sélection LOD et élagage). */
  readonly lastViewProj: Float32Array;
  readonly lastCamPos: Float32Array | [number, number, number];
  /** proj[1][1] de la dernière mise à jour de caméra (focale de taille écran du LOD). */
  readonly lastProjScaleY: number;

  resize(width: number, height: number): void;
  /**
   * Distances proche/lointaine de la vue courante. Le backend WebGPU rend en
   * Z inversé avec un plan lointain à l'infini et les ignore ; WebGL 2 n'a pas
   * de clip control standard (absent de Firefox), il en construit donc une
   * projection finie.
   */
  setDepthRange(near: number, far: number): void;
  /** @param projMat projection de rendu en Z inversé, lointain à l'infini (`CameraController.getRenderProjMatrix`). */
  updateCamera(viewMat: Float32Array, projMat: Float32Array, camPos: [number, number, number] | Float32Array): void;
  /** Décalage sous-pixel (px du canvas) des prochains appels à `updateCamera`, pour les images fixes accumulées. */
  setSubpixelJitter(x: number, y: number): void;
  setEyeLevelPoints(enabled: boolean): void;
  /** Rend le terrain, les nœuds LOD donnés (de l'avant vers l'arrière) et les surcouches. */
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
  /** Triangles colorés translucides dans le repère de rendu, dessinés comme le tracé (sans écriture de profondeur). */
  setAnalysisMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void;
  clearAnalysisMesh(): void;

  /** Coupe le MSAA (première étape de la baisse de qualité automatique) ; false s'il était déjà coupé. */
  disableMsaa(): Promise<boolean>;
  /** Nombre maximal de nœuds LOD que le pool GPU peut contenir à la fois. */
  getNodeCapacity(): number;
  /** Coût GPU lissé des passes de dessin par image en ms (0 tant que non mesuré). */
  getGpuFrameMs(): number;
  /** Coût GPU lissé de la passe d'ombrage des points par image en ms (0 tant que non mesuré). */
  getGpuShadeMs(): number;
  /** False quand le coût d'image n'est pas mesuré sur le GPU (pas de requêtes timestamp / timer). */
  hasPreciseGpuTiming(): boolean;
  getLastRenderStats(): RenderStats;
  /** Part de la résolution du canvas à laquelle la dernière image a été rendue. */
  getLastRenderScale(): number;
  destroy(): void;
}
