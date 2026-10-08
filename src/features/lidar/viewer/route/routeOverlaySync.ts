import { geoToLocal3D, projectToScreen, type ProjectedScreenPoint } from './terrainRaycaster';
import type { CameraController } from '../camera';
import type { DraggingHandleInfo, RouteHandleInfo } from './routeHandlesOverlay';
import type { LidarRouteOverlayPoint, ViewerRouteSceneParams } from './types';

/** Les points du tracé hors de la scène au-delà de cette part de sa taille n'ont pas de poignée. */
const SCENE_MARGIN_RATIO = 0.05;

const OFF_SCENE: ProjectedScreenPoint = { screenX: -1e6, screenY: -1e6, inFront: false, distance: Infinity };

/**
 * Poignées d'un tracé dans une scène. Un long itinéraire a des dizaines de
 * milliers de points, surtout hors de la scène : géo → CRS → MNT (une projection
 * et une lecture de heightmap par point) tourne une fois par édition du tracé,
 * puis chaque pose de caméra ne reprojette que les points dans la scène, dans
 * des objets poignée réutilisés d'une image à l'autre.
 */
export class RouteHandleCache {
  readonly points: LidarRouteOverlayPoint[];
  readonly sceneParams: ViewerRouteSceneParams;
  /** Alignées par indice avec les points du tracé. */
  readonly handles: RouteHandleInfo[];
  /** Position écran de chaque point du tracé (les points hors scène ne sont jamais devant). */
  readonly projected: ProjectedScreenPoint[];
  /** Points dans la scène (plus une marge) : les seuls qui ont un MNT sous eux. */
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

  /** Reprojette les points dans la scène quand la caméra ou le canvas ont changé. */
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

  /** Marque les poignées sélectionnée et survolée. */
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
