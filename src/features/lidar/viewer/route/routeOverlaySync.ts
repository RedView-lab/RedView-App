import { geoToLocal3D, projectToScreen } from './terrainRaycaster';
import type { CameraController } from '../camera';
import type { DraggingHandleInfo, RouteHandleInfo } from './routeHandlesOverlay';
import type { LidarRouteOverlayPoint, ViewerRouteSceneParams } from './types';

export function buildRouteHandles(
  points: LidarRouteOverlayPoint[],
  selectedPointIndex: number | null,
  hoveredPointIndex: number | null,
  sceneParams: ViewerRouteSceneParams,
  canvas: HTMLCanvasElement,
  camera: CameraController,
): RouteHandleInfo[] {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const viewMat = camera.getViewMatrix();
  const projMat = camera.getProjMatrix();

  const handles: RouteHandleInfo[] = [];
  const total = points.length;
  let cumulativeM = 0;

  for (let i = 0; i < total; i++) {
    const pt = points[i]!;
    if (i > 0) {
      const prev = points[i - 1]!;
      const dLat = (pt.lat - prev.lat) * 111139;
      const dLon = (pt.lon - prev.lon) * 111139 * Math.cos(((pt.lat + prev.lat) * 0.5 * Math.PI) / 180);
      cumulativeM += Math.hypot(dLat, dLon);
    }

    const { localX, localY, localZ, elevationM } = geoToLocal3D(
      pt.lat,
      pt.lon,
      sceneParams,
      0.65,
      pt.elevationM,
    );

    const screenPt = projectToScreen(localX, localY, localZ, width, height, viewMat, projMat);

    handles.push({
      index: i,
      lat: pt.lat,
      lon: pt.lon,
      elevationM: pt.elevationM ?? elevationM,
      distanceM: pt.distanceM ?? cumulativeM,
      localX,
      localY,
      localZ,
      screenPoint: screenPt,
      isStart: i === 0,
      isEnd: i === total - 1,
      isSelected: i === selectedPointIndex,
      isHovered: i === hoveredPointIndex,
    });
  }

  return handles;
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
