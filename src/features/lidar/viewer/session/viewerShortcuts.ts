import { isGoogleEarthShortcut, openGoogleEarthView } from '@/shared/lib/googleEarthView';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import type { CameraController } from '../camera';
import { googleEarthViewFromViewer } from '../googleEarth';
import type { SnowModeKey } from '../panel/controller';
import {
  FIXED_POINT_PX_MAX,
  FIXED_POINT_PX_MIN,
  POINT_SIZE_MAX,
  POINT_SIZE_MIN,
} from '../panel/sliderScales';
import type { PhotoModeController } from '../photoMode/photoModeController';
import type { LidarRenderer } from '../renderer/sceneRenderer';
import type { ViewerRouteController } from '../route/viewerRouteController';
import type { ViewerRouteSceneParams } from '../route/types';
import type { SnowSceneContext, ViewerSnowController } from './viewerSnowController';

export interface ViewerShortcutsDeps {
  getRenderer: () => LidarRenderer | null;
  getPhoto: () => PhotoModeController | null;
  camera: CameraController;
  heightSceneParams: ViewerRouteSceneParams;
  routeController: ViewerRouteController;
  snowController: ViewerSnowController;
  snowContext: () => SnowSceneContext;
  panel: {
    setSnowMode: (mode: SnowModeKey) => void;
    setPointSizePercent: (percent: number) => void;
  };
  pointSizeSliderPercent: (renderer: LidarRenderer) => number;
  toggleLodStats: () => void;
  requestRender: () => void;
}

/** Keyboard shortcuts of the viewer (photo interface, Google Earth, route edit, point size, terrain, snow…). */
export function createViewerKeyDownHandler(deps: ViewerShortcutsDeps): (e: KeyboardEvent) => void {
  const { camera, heightSceneParams, routeController, snowController, panel } = deps;
  return (e: KeyboardEvent) => {
    const renderer = deps.getRenderer();
    if (!renderer) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
      return;
    }
    const photo = deps.getPhoto();
    if (photo?.active && (e.key === 'i' || e.key === 'I') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Interface hidden while framing a photo.
      photo.setInterfaceHidden(!photo.interfaceHidden);
      return;
    }
    if (e.key === 'Escape' && photo?.interfaceHidden) {
      photo.setInterfaceHidden(false);
      return;
    }
    if (isGoogleEarthShortcut(e)) {
      if (isTypingTarget(e.target)) return;
      const view = googleEarthViewFromViewer(camera, heightSceneParams);
      if (view) {
        e.preventDefault();
        trackAnalyticsEvent({ name: 'google_earth_opened', data: { from: 'lidar' } });
        openGoogleEarthView(view);
      }
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      const curState = routeController.getState();
      routeController.setEditMode(!curState.editMode);
      return;
    }
    const sizeStep = e.key === '+' || e.key === '=' ? 1.2 : e.key === '-' || e.key === '_' ? 1 / 1.2 : 1;
    if (renderer.fixedPointPixels > 0) {
      renderer.fixedPointPixels = Math.max(FIXED_POINT_PX_MIN, Math.min(FIXED_POINT_PX_MAX, renderer.fixedPointPixels * sizeStep));
    } else {
      renderer.pointSize = Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, renderer.pointSize * sizeStep));
    }
    if (e.key === 't' || e.key === 'T') renderer.terrainVisible = !renderer.terrainVisible;
    if (e.key === 'l' || e.key === 'L') renderer.adaptivePointSize = !renderer.adaptivePointSize;
    if (e.key === 'q' || e.key === 'Q') deps.toggleLodStats();
    if (e.key === 'n' || e.key === 'N') {
      const nextMode: SnowModeKey = snowController.getMode() === 'off'
        ? 'cover'
        : snowController.getMode() === 'cover'
          ? 'thickness'
          : 'off';
      void snowController.handleSnowModeChange(nextMode, deps.snowContext(), (next) => panel.setSnowMode(next));
    }
    panel.setPointSizePercent(deps.pointSizeSliderPercent(renderer));
    deps.requestRender();
  };
}
