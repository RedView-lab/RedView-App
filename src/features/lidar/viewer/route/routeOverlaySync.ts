import { geoToLocal3D, projectToScreen, type ProjectedScreenPoint } from './terrainRaycaster';
import type { CameraController } from '../camera';
import type { DraggingHandleInfo, RouteHandleInfo } from './routeHandlesOverlay';
import type { LidarRouteOverlayPoint, ViewerRouteSceneParams } from './types';

/** Route points farther than this share of the scene size outside it get no handle. */
const SCENE_MARGIN_RATIO = 0.05;

const OFF_SCENE: ProjectedScreenPoint = { screenX: -1e6, screenY: -1e6, inFront: false, distance: Infinity };

/**
 * Handles of one route in one scene. A long itinerary has tens of thousands
 * of points, mostly outside the scene: geo → CRS → DTM (a projection and a
 * heightmap lookup per point) runs once per route edit, then each camera
 * pose only re-projects the points inside the scene, into handle objects
 * that are reused from frame to frame.
 */
export class RouteHandleCache {
  readonly points: LidarRouteOverlayPoint[];
  readonly sceneParams: ViewerRouteSceneParams;
  /** Index-aligned with the route points. */
  readonly handles: RouteHandleInfo[];
  /** Screen position of every route point (off-scene points are never in front). */
  readonly projected: ProjectedScreenPoint[];
  /** Points inside the scene (plus a margin): the only ones with a DTM under them. */
  private readonly inScene: number[] = [];
  private poseKey: number[] = [];
  private selected: number | null = null;
  private hovered: number | null = null;

  constructor(points: LidarRouteOverlayPoint[], sceneParams: ViewerRouteSceneParams) {
    this.points = points;
    this.sceneParams = sceneParams;
    const { bounds } = sceneParams;
    const marginX = (bounds.maxX - bounds.minX) * SCENE_MARGIN_RATIO;
    const marginY = (bounds.maxY - bounds.minY) * SCENE_MARGIN_RATIO;
    const total = points.length;
    this.handles = new Array(total);
    this.projected = new Array(total).fill(OFF_SCENE);
    let cumulativeM = 0;

    for (let i = 0; i < total; i++) {
      const pt = points[i]!;
      if (i > 0) {
        const prev = points[i - 1]!;
        const dLat = (pt.lat - prev.lat) * 111139;
        const dLon = (pt.lon - prev.lon) * 111139 * Math.cos(((pt.lat + prev.lat) * 0.5 * Math.PI) / 180);
        cumulativeM += Math.hypot(dLat, dLon);
      }

      const { localX, localY, localZ, projX, projY, elevationM } = geoToLocal3D(pt.lat, pt.lon, sceneParams, 0.65, pt.elevationM);
      if (projX >= bounds.minX - marginX && projX <= bounds.maxX + marginX
        && projY >= bounds.minY - marginY && projY <= bounds.maxY + marginY) {
        this.inScene.push(i);
      }
      this.handles[i] = {
        index: i,
        lat: pt.lat,
        lon: pt.lon,
        elevationM: pt.elevationM ?? elevationM,
        distanceM: pt.distanceM ?? cumulativeM,
        localX,
        localY,
        localZ,
        screenPoint: OFF_SCENE,
        isStart: i === 0,
        isEnd: i === total - 1,
        isSelected: false,
        isHovered: false,
      };
    }
  }

  /** Re-projects the points inside the scene when the camera or the canvas changed. */
  project(canvas: HTMLCanvasElement, camera: CameraController): void {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const key = [...camera.getViewKey(), width, height];
    if (key.every((value, i) => value === this.poseKey[i])) return;
    this.poseKey = key;
    const viewMat = camera.getViewMatrix();
    const projMat = camera.getProjMatrix();
    for (const i of this.inScene) {
      const handle = this.handles[i]!;
      const screenPoint = projectToScreen(handle.localX, handle.localY, handle.localZ, width, height, viewMat, projMat);
      this.projected[i] = screenPoint;
      handle.screenPoint = screenPoint;
    }
  }

  /** Flags the selected and hovered handles. */
  setHighlight(selected: number | null, hovered: number | null): void {
    if (selected !== this.selected) {
      if (this.selected != null && this.handles[this.selected]) this.handles[this.selected]!.isSelected = false;
      if (selected != null && this.handles[selected]) this.handles[selected]!.isSelected = true;
      this.selected = selected;
    }
    if (hovered !== this.hovered) {
      if (this.hovered != null && this.handles[this.hovered]) this.handles[this.hovered]!.isHovered = false;
      if (hovered != null && this.handles[hovered]) this.handles[hovered]!.isHovered = true;
      this.hovered = hovered;
    }
  }
}

export function buildDraggingHandleInfo(
  dragPointIndex: number | null,
  isDragging: boolean,
  handles: RouteHandleInfo[],
  total: number,
): DraggingHandleInfo | null {
  if (!isDragging || dragPointIndex == null || !handles[dragPointIndex]) {
    return null;
  }

  const curHandle = handles[dragPointIndex]!;
  const prevHandle = dragPointIndex > 0 ? handles[dragPointIndex - 1] : null;
  const nextHandle = dragPointIndex < total - 1 ? handles[dragPointIndex + 1] : null;

  return {
    index: dragPointIndex,
    currentLat: curHandle.lat,
    currentLon: curHandle.lon,
    currentElevationM: curHandle.elevationM ?? 0,
    currentScreenPoint: curHandle.screenPoint,
    prevScreenPoint: prevHandle?.screenPoint ?? null,
    nextScreenPoint: nextHandle?.screenPoint ?? null,
  };
}
