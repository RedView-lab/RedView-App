// ============================================
// Photo mode — renderer contract (WebGPU only)
// ============================================

import type { AABB } from '../../lod/types';
import type { SceneNode } from '../../lod/sceneLod';
import type { FrustumPlanes } from '../../lod/frustum';
import type { CloudLayer } from '../lib/cloudPresets';

/** What the renderer draws, resolved from the panel state by the controller. */
export interface PhotoRenderSettings {
  /** Unit vector towards the sun, render frame. */
  sunDirection: [number, number, number];
  cloud: CloudLayer;
  /** Haze 0–1 (aerosol density). */
  haze: number;
  exposureEv: number;
}

/** The scene, in the render frame (x east, y up, z south; metres from its centre). */
export interface PhotoSceneInfo {
  bounds: AABB;
  /** Altitude (m) of the render frame's origin. */
  centerAltitudeM: number;
  minAltitudeM: number;
  maxAltitudeM: number;
  /** Mean albedo of the ground (linear), for the distant ground and the bounce light. */
  groundAlbedo: number;
}

/** Shadow casters: resident LOD nodes in a light frustum (`SceneLod.selectShadowCasters`). */
export interface PhotoCasterSource {
  select(planes: FrustumPlanes, texelM: number, maxPoints: number, out: SceneNode[]): number;
  /** Changes whenever nodes become resident (re-render the shadow maps). */
  version(): number;
}

export interface PhotoModeRenderer {
  readonly active: boolean;
  setActive(active: boolean): void;
  setSettings(settings: PhotoRenderSettings): void;
  setScene(scene: PhotoSceneInfo): void;
  setCasterSource(source: PhotoCasterSource | null): void;
  /** Area the camera looks at: the detail shadow cascade covers a square of 2·halfSizeM around it. */
  setFocus(centre: [number, number, number], halfSizeM: number): void;
  /** The image still changes without a camera move: volumes being built, clouds converging, capture. */
  needsFrames(): boolean;
  /** Still frames of the clouds' accumulation done / needed (done = total without clouds). */
  cloudProgress(): { done: number; total: number };
  /** Smoothed GPU time of the clouds per frame (ms). */
  getCloudMs(): number;
  /** PNG of the next rendered frame (without the interface); request a frame after calling it. */
  capture(): Promise<Blob>;
}
