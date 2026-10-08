import { resolveSunTimesForLocalDay } from '@/features/sunlight/lib/sun-calc';
import { trueNorthGridBearingDeg } from '../../lib/coordConvert';
import type { DetectedCrs } from '../../types';
import type { AdaptivePointBudget } from '../lod/lodBudget';
import type { RestRefinement } from '../lod/restRefinement';
import type { SceneLod } from '../lod/sceneLod';
import { PHOTO_MODE_ENABLED } from '../photoMode/featureFlag';
import { cloudBaseOffsetRange, defaultCloudBaseAltitude } from '../photoMode/lib/cloudPresets';
import { readPhotoPreferences } from '../photoMode/lib/photoPreferences';
import { defaultPhotoTime } from '../photoMode/lib/photoTime';
import { parsePhotoUrlOverrides } from '../photoMode/lib/photoUrlParams';
import { PhotoModeController } from '../photoMode/photoModeController';
import type { PhotoCaptureStatus, PhotoModeState } from '../photoMode/types';
import type { LidarRenderer } from '../renderer/sceneRenderer';
import type { ViewerPhotoModeProps } from '../rightPanel/LidarViewerRightPanel';
import { meanTerrainAlbedo } from './terrainAlbedo';

export interface PhotoModeSetupInput {
  renderer: LidarRenderer;
  sceneBounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  terrainMesh: { heightGrid: Iterable<number>; colors: Uint8Array };
  cx: number;
  cy: number;
  cz: number;
  crs: DetectedCrs;
  lat: number;
  lon: number;
  timeZone: string;
  sceneLod: SceneLod;
  restRefinement: RestRefinement;
  pointBudget: AdaptivePointBudget;
  captureName: string;
  requestRender: () => void;
  requestFrame: () => void;
  onActiveChange: (active: boolean) => void;
}

export interface PhotoModeSetup {
  /** Null when the renderer has no photo mode (WebGL 2). */
  photo: PhotoModeController | null;
  /** The right panel's photo section; undefined while the mode is frozen (photoMode/featureFlag.ts). */
  panelSection: ViewerPhotoModeProps | undefined;
}

/** Photo mode (WebGPU): sky, clouds, shadows of the point cloud. */
export function setUpPhotoMode(input: PhotoModeSetupInput): PhotoModeSetup {
  const { renderer, sceneBounds, terrainMesh, cx, cy, cz, crs, lat, lon, timeZone, sceneLod } = input;
  let groundMin = Infinity;
  for (const h of terrainMesh.heightGrid) if (Number.isFinite(h) && h < groundMin) groundMin = h;
  const sceneMinAltM = Number.isFinite(groundMin) ? cz + groundMin : sceneBounds.minZ;
  const sceneMaxAltM = sceneBounds.maxZ;
  const cloudAutoAltM = defaultCloudBaseAltitude(sceneMinAltM, sceneMaxAltM);
  const cloudOffsetRange = cloudBaseOffsetRange(sceneMinAltM, sceneMaxAltM);
  let photo: PhotoModeController | null = null;
  if (renderer.photo) {
    photo = new PhotoModeController({
      photo: renderer.photo,
      site: { lat, lon, timeZone, trueNorthGridBearingDeg: trueNorthGridBearingDeg(cx, cy, crs) },
      scene: {
        bounds: {
          minX: sceneBounds.minX - cx, maxX: sceneBounds.maxX - cx,
          minY: sceneBounds.minZ - cz, maxY: sceneBounds.maxZ - cz,
          minZ: -(sceneBounds.maxY - cy), maxZ: -(sceneBounds.minY - cy),
        },
        centerAltitudeM: cz,
        minAltitudeM: sceneMinAltM,
        maxAltitudeM: sceneMaxAltM,
        groundAlbedo: meanTerrainAlbedo(terrainMesh.colors),
      },
      casters: {
        select: (planes, texelM, maxPoints, out) => sceneLod.selectShadowCasters(planes, texelM, maxPoints, out),
        version: () => sceneLod.getUploadedNodes(),
      },
      restRefinement: input.restRefinement,
      pointBudget: input.pointBudget,
      captureName: input.captureName,
      requestRender: input.requestRender,
      requestFrame: input.requestFrame,
      onActiveChange: input.onActiveChange,
    });
  }
  const photoToday = new Date().toISOString().slice(0, 10);
  const photoOverrides = parsePhotoUrlOverrides(new URLSearchParams(window.location.search));
  const initialPhotoState: PhotoModeState = {
    date: photoToday,
    time: defaultPhotoTime(resolveSunTimesForLocalDay(photoToday, lat, lon, timeZone).sunsetTime),
    ...readPhotoPreferences(),
    ...photoOverrides,
    enabled: photo !== null && photoOverrides.enabled === true,
  };
  const idleCapture: PhotoCaptureStatus = { busy: false, done: 0, total: 0, error: null };

  // Photo mode frozen (photoMode/featureFlag.ts): no panel section.
  const panelSection: ViewerPhotoModeProps | undefined = PHOTO_MODE_ENABLED ? {
    available: photo !== null,
    initialState: initialPhotoState,
    cloudBase: { autoAltitudeM: cloudAutoAltM, minOffsetM: cloudOffsetRange.min, maxOffsetM: cloudOffsetRange.max },
    onChange: (state) => photo?.apply(state),
    onCapture: () => void photo?.capture(),
    captureStore: photo
      ? { subscribe: photo.subscribeCapture, getSnapshot: photo.getCaptureStatus }
      : { subscribe: () => () => undefined, getSnapshot: () => idleCapture },
  } : undefined;
  return { photo, panelSection };
}
