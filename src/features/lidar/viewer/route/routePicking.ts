import {
  geoToLocal3D,
  projectToScreen,
  raycastTerrain,
  sampleElevationAtProj,
  unprojectScreenRay,
  type ProjectedScreenPoint,
  type TerrainHitResult,
} from './terrainRaycaster';
import type { CameraController } from '../camera';
import type { HoverReticleInfo, InsertGhostHandle } from './routeHandlesOverlay';
import type { LidarRouteOverlayPoint, ViewerRouteSceneParams } from './types';

export const POINT_PICK_THRESHOLD_PX = 14;
export const SEGMENT_PICK_THRESHOLD_PX = 12;

export function raycastAtScreen(
  screenX: number,
  screenY: number,
  canvas: HTMLCanvasElement,
  camera: CameraController,
  sceneParams: ViewerRouteSceneParams,
): TerrainHitResult | null {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const viewMat = camera.getViewMatrix();
  const projMat = camera.getProjMatrix();

  const ray = unprojectScreenRay(screenX, screenY, width, height, viewMat, projMat);
  if (!ray) return null;

  return raycastTerrain(ray, sceneParams, camera.getEye());
}

export function projectPointsToScreen(
  points: LidarRouteOverlayPoint[],
  sceneParams: ViewerRouteSceneParams,
  canvas: HTMLCanvasElement,
  camera: CameraController,
): Array<{ screenX: number; screenY: number; inFront: boolean }> {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const viewMat = camera.getViewMatrix();
  const projMat = camera.getProjMatrix();

  const projectedNodes: Array<{ screenX: number; screenY: number; inFront: boolean }> = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!;
    const { localX, localY, localZ } = geoToLocal3D(pt.lat, pt.lon, sceneParams, 0.65, pt.elevationM);
    const scr = projectToScreen(localX, localY, localZ, width, height, viewMat, projMat);
    projectedNodes.push(scr);
  }
  return projectedNodes;
}

export function findHoveredHandle(
  screenX: number,
  screenY: number,
  projectedNodes: Array<{ screenX: number; screenY: number; inFront: boolean }>,
  thresholdPx = POINT_PICK_THRESHOLD_PX,
): number | null {
  let nearestIndex: number | null = null;
  let minDist = thresholdPx;

  for (let i = 0; i < projectedNodes.length; i++) {
    const scr = projectedNodes[i]!;
    if (scr.inFront) {
      const d = Math.hypot(scr.screenX - screenX, scr.screenY - screenY);
      if (d < minDist) {
        minDist = d;
        nearestIndex = i;
      }
    }
  }

  return nearestIndex;
}

export function findHoveredGhostSegment(
  screenX: number,
  screenY: number,
  points: LidarRouteOverlayPoint[],
  projectedNodes: Array<{ screenX: number; screenY: number; inFront: boolean }>,
  sceneParams: ViewerRouteSceneParams,
  canvas: HTMLCanvasElement,
  camera: CameraController,
  thresholdPx = SEGMENT_PICK_THRESHOLD_PX,
): InsertGhostHandle | null {
  if (points.length < 2) return null;

  let nearestSegIndex: number | null = null;
  let minSegDist = thresholdPx;
  let closestSegT = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = projectedNodes[i]!;
    const p1 = projectedNodes[i + 1]!;
    if (!p0.inFront || !p1.inFront) continue;

    const vx = p1.screenX - p0.screenX;
    const vy = p1.screenY - p0.screenY;
    const lenSq = vx * vx + vy * vy;
    if (lenSq < 10) continue;

    const t = Math.max(0.08, Math.min(0.92, ((screenX - p0.screenX) * vx + (screenY - p0.screenY) * vy) / lenSq));
    const px = p0.screenX + vx * t;
    const py = p0.screenY + vy * t;
    const dist = Math.hypot(screenX - px, screenY - py);

    if (dist < minSegDist) {
      minSegDist = dist;
      nearestSegIndex = i;
      closestSegT = t;
    }
  }

  if (nearestSegIndex == null) return null;

  const p0 = points[nearestSegIndex]!;
  const p1 = points[nearestSegIndex + 1]!;
  const interpLat = p0.lat + (p1.lat - p0.lat) * closestSegT;
  const interpLon = p0.lon + (p1.lon - p0.lon) * closestSegT;

  const { localX, localY, localZ, elevationM } = geoToLocal3D(
    interpLat,
    interpLon,
    sceneParams,
    0.65,
  );

  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const viewMat = camera.getViewMatrix();
  const projMat = camera.getProjMatrix();
  const scr = projectToScreen(localX, localY, localZ, width, height, viewMat, projMat);

  return {
    segmentIndex: nearestSegIndex,
    lat: interpLat,
    lon: interpLon,
    elevationM,
    localX,
    localY,
    localZ,
    screenPoint: scr,
  };
}

export function computeAppendHoverReticle(
  screenX: number,
  screenY: number,
  hit: TerrainHitResult | null,
  lastPoint: LidarRouteOverlayPoint | undefined,
  sceneParams: ViewerRouteSceneParams,
  canvas: HTMLCanvasElement,
  camera: CameraController,
): HoverReticleInfo | null {
  if (!hit) return null;

  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const viewMat = camera.getViewMatrix();
  const projMat = camera.getProjMatrix();

  let lastPointScreen: ProjectedScreenPoint | null = null;
  let groundPoints: ProjectedScreenPoint[] | null = null;
  let groundPoints3D: Array<[number, number, number]> | null = null;

  if (lastPoint) {
    const { localX: startX, localY: startY, localZ: startZ, projX: p0X, projY: p0Y } = geoToLocal3D(
      lastPoint.lat,
      lastPoint.lon,
      sceneParams,
      0.65,
      lastPoint.elevationM,
    );
    lastPointScreen = projectToScreen(startX, startY, startZ, width, height, viewMat, projMat);

    const p1X = hit.projX;
    const p1Y = hit.projY;
    const distM = Math.hypot(p1X - p0X, p1Y - p0Y);

    groundPoints3D = [];
    groundPoints = [];

    // Densify along terrain surface between lastPoint and hit for smooth ground draping
    const stepM = 2.0;
    const steps = Math.max(2, Math.min(350, Math.ceil(distM / stepM)));

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      let lx: number;
      let ly: number;
      let lz: number;

      if (s === 0) {
        lx = startX;
        ly = startY;
        lz = startZ;
      } else if (s === steps) {
        lx = hit.localX;
        ly = hit.localY + 0.65;
        lz = hit.localZ;
      } else {
        const curProjX = p0X + (p1X - p0X) * t;
        const curProjY = p0Y + (p1Y - p0Y) * t;
        const terrY = sampleElevationAtProj(curProjX, curProjY, sceneParams);
        lx = curProjX - sceneParams.centerX;
        ly = terrY + 0.65;
        lz = -(curProjY - sceneParams.centerY);
      }

      groundPoints3D.push([lx, ly, lz]);
      const scr = projectToScreen(lx, ly, lz, width, height, viewMat, projMat);
      groundPoints.push(scr);
    }
  }

  return {
    screenX,
    screenY,
    elevationM: hit.elevationM,
    lastPointScreen,
    groundPoints,
    groundPoints3D,
  };
}
