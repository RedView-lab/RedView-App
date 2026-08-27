import type { CameraController } from '../camera';
import type { HoverReticleInfo, InsertGhostHandle } from './routeHandlesOverlay';
import type { LidarRouteOverlayItem, LidarRouteOverlayPoint, ViewerRouteSceneParams } from './types';
import type { RouteEditTool } from './routeEditorController';
import {
  computeAppendHoverReticle,
  findHoveredGhostSegment,
  findHoveredHandle,
  projectPointsToScreen,
  raycastAtScreen,
} from './routePicking';

export interface RouteEditorHost {
  canvas: HTMLCanvasElement;
  camera: CameraController;
  getSceneParams(): ViewerRouteSceneParams;
  getActiveRoute(): LidarRouteOverlayItem | null;
  editMode: boolean;
  activeTool: RouteEditTool;
  selectedPointIndex: number | null;
  hoveredPointIndex: number | null;
  hoveredGhost: InsertGhostHandle | null;
  hoverReticle: HoverReticleInfo | null;
  isDragging: boolean;
  dragPointIndex: number | null;
  dragInitialPoints: LidarRouteOverlayPoint[] | null;
  setEditMode(enabled: boolean): void;
  setSelectedPointIndex(idx: number | null): void;
  deleteSelectedPoint(): boolean;
  undo(): boolean;
  redo(): boolean;
  pushHistory(points: LidarRouteOverlayPoint[]): void;
  onPointsChangeLive(points: LidarRouteOverlayPoint[]): void;
  onPointsChangeCommit(points: LidarRouteOverlayPoint[], actionName?: string): void;
  notifyStateChange(): void;
  updateOverlay(): void;
  requestRender(): void;
}

export class RouteEditorInputManager {
  private host: RouteEditorHost;
  private isPointerDown = false;
  private pointerDownScreenX = 0;
  private pointerDownScreenY = 0;
  private pointerDownTime = 0;
  private rightDownX = 0;
  private rightDownY = 0;
  private rightDownTime = 0;

  constructor(host: RouteEditorHost) {
    this.host = host;
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    const canvas = this.host.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    canvas.addEventListener('mousedown', this.onMouseDownCapture, { capture: true });
    canvas.addEventListener('contextmenu', this.onContextMenu, { capture: true });
    window.addEventListener('pointermove', this.onPointerMove, { capture: true });
    window.addEventListener('mousemove', this.onMouseMoveCapture, { capture: true });
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('mouseup', this.onMouseUpCapture, { capture: true });
    window.addEventListener('keydown', this.onKeyDown);
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private onMouseDownCapture = (e: MouseEvent): void => {
    if (e.button === 0 && (this.host.hoveredPointIndex != null || this.host.hoveredGhost != null || this.host.isDragging)) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.host.camera.setLocked(true);
    }
  };

  private onMouseMoveCapture = (e: MouseEvent): void => {
    if (this.host.isDragging) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.host.camera.setLocked(true);
    }
  };

  private onMouseUpCapture = (): void => {
    if (!this.isPointerDown && !this.host.isDragging) {
      this.host.camera.setLocked(false);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) {
      this.rightDownX = e.clientX;
      this.rightDownY = e.clientY;
      this.rightDownTime = performance.now();
      return;
    }

    if (e.button !== 0) return;

    this.isPointerDown = true;
    const activeRoute = this.host.getActiveRoute();
    if (!activeRoute) return;

    const rect = this.host.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    this.pointerDownScreenX = screenX;
    this.pointerDownScreenY = screenY;
    this.pointerDownTime = performance.now();

    // 1) Test if clicking on an existing point handle
    if (this.host.hoveredPointIndex != null) {
      const idx = this.host.hoveredPointIndex;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.host.camera.setLocked(true);

      if (this.host.activeTool === 'delete') {
        this.host.setSelectedPointIndex(idx);
        this.host.deleteSelectedPoint();
        return;
      }

      this.host.setSelectedPointIndex(idx);
      this.host.isDragging = true;
      this.host.dragPointIndex = idx;
      this.host.dragInitialPoints = structuredClone(activeRoute.points);
      this.host.canvas.style.cursor = 'grabbing';
      this.host.notifyStateChange();
      this.host.updateOverlay();
      this.host.requestRender();
      return;
    }

    // 2) Test if clicking on a ghost insert handle
    if (this.host.hoveredGhost != null) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.host.camera.setLocked(true);

      const ghost = this.host.hoveredGhost;
      const points = activeRoute.points;
      this.host.pushHistory(points);

      const newPoint: LidarRouteOverlayPoint = {
        lat: ghost.lat,
        lon: ghost.lon,
        elevationM: ghost.elevationM,
      };

      const newPoints = [
        ...points.slice(0, ghost.segmentIndex + 1),
        newPoint,
        ...points.slice(ghost.segmentIndex + 1),
      ];

      const insertedIndex = ghost.segmentIndex + 1;
      this.host.setSelectedPointIndex(insertedIndex);
      this.host.isDragging = true;
      this.host.dragPointIndex = insertedIndex;
      this.host.dragInitialPoints = structuredClone(newPoints);
      this.host.hoveredGhost = null;
      this.host.canvas.style.cursor = 'grabbing';

      this.host.onPointsChangeCommit(newPoints, 'insert_point');
      this.host.notifyStateChange();
      this.host.updateOverlay();
      this.host.requestRender();
      return;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.host.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const activeRoute = this.host.getActiveRoute();
    if (!activeRoute) return;

    const sceneParams = this.host.getSceneParams();

    // A) Empty route append hover
    if (activeRoute.points.length === 0) {
      if (this.host.editMode && this.host.activeTool === 'append') {
        const hit = raycastAtScreen(screenX, screenY, this.host.canvas, this.host.camera, sceneParams);
        if (hit) {
          this.host.hoverReticle = {
            screenX,
            screenY,
            elevationM: hit.elevationM,
            lastPointScreen: null,
          };
          this.host.canvas.style.cursor = 'crosshair';
        } else {
          this.host.hoverReticle = null;
          this.host.canvas.style.cursor = 'default';
        }
      } else {
        this.host.hoverReticle = null;
        this.host.canvas.style.cursor = 'default';
      }
      this.host.updateOverlay();
      return;
    }

    // B) Handle Dragging Point in 3D (Snapping to Terrain in real-time)
    if (this.host.isDragging && this.host.dragPointIndex != null) {
      const hit = raycastAtScreen(screenX, screenY, this.host.canvas, this.host.camera, sceneParams);
      if (hit) {
        const points = [...activeRoute.points];
        const cur = points[this.host.dragPointIndex]!;
        points[this.host.dragPointIndex] = {
          ...cur,
          lat: hit.lat,
          lon: hit.lon,
          elevationM: hit.elevationM,
        };

        this.host.onPointsChangeLive(points);
        this.host.updateOverlay();
        this.host.requestRender();
      }
      return;
    }

    // C) Hover Detection (Handles & Segments)
    const points = activeRoute.points;
    const projectedNodes = projectPointsToScreen(points, sceneParams, this.host.canvas, this.host.camera);
    const nearestPointIndex = findHoveredHandle(screenX, screenY, projectedNodes);

    this.host.hoveredPointIndex = nearestPointIndex;

    if (nearestPointIndex != null) {
      this.host.hoveredGhost = null;
      this.host.hoverReticle = null;
      this.host.canvas.style.cursor = this.host.activeTool === 'delete' ? 'not-allowed' : 'grab';
      this.host.updateOverlay();
      return;
    }

    if (this.host.editMode && this.host.activeTool === 'append') {
      this.host.hoveredGhost = null;
      const hit = raycastAtScreen(screenX, screenY, this.host.canvas, this.host.camera, sceneParams);
      this.host.hoverReticle = computeAppendHoverReticle(
        screenX,
        screenY,
        hit,
        points[points.length - 1],
        sceneParams,
        this.host.canvas,
        this.host.camera,
      );
      this.host.canvas.style.cursor = this.host.hoverReticle ? 'crosshair' : 'default';
      this.host.updateOverlay();
      return;
    }

    this.host.hoverReticle = null;

    if (this.host.activeTool !== 'delete') {
      this.host.hoveredGhost = findHoveredGhostSegment(
        screenX,
        screenY,
        points,
        projectedNodes,
        sceneParams,
        this.host.canvas,
        this.host.camera,
      );

      if (this.host.hoveredGhost != null) {
        this.host.canvas.style.cursor = 'pointer';
        this.host.updateOverlay();
        return;
      }
    }

    this.host.hoveredGhost = null;
    this.host.canvas.style.cursor = 'default';
    this.host.updateOverlay();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.isPointerDown = false;
    this.host.camera.setLocked(false);

    if (e.button === 2) {
      const moveDist = Math.hypot(e.clientX - this.rightDownX, e.clientY - this.rightDownY);
      const elapsed = performance.now() - this.rightDownTime;
      if (moveDist < 6 && elapsed < 350) {
        if (this.host.editMode) {
          this.host.setEditMode(false);
        } else if (this.host.selectedPointIndex != null) {
          this.host.setSelectedPointIndex(null);
          this.host.notifyStateChange();
          this.host.updateOverlay();
        }
      }
      return;
    }

    if (this.host.isDragging && this.host.dragPointIndex != null) {
      const activeRoute = this.host.getActiveRoute();
      if (activeRoute && this.host.dragInitialPoints) {
        this.host.pushHistory(this.host.dragInitialPoints);
        this.host.onPointsChangeCommit(activeRoute.points, 'move_point');
      }

      this.host.isDragging = false;
      this.host.dragPointIndex = null;
      this.host.dragInitialPoints = null;
      this.host.canvas.style.cursor = 'default';
      this.host.notifyStateChange();
      this.host.updateOverlay();
      this.host.requestRender();
      return;
    }

    if (this.host.editMode && this.host.activeTool === 'append') {
      const rect = this.host.canvas.getBoundingClientRect();
      const upX = e.clientX - rect.left;
      const upY = e.clientY - rect.top;
      const moveDist = Math.hypot(upX - this.pointerDownScreenX, upY - this.pointerDownScreenY);
      const elapsed = performance.now() - this.pointerDownTime;

      if (moveDist < 6 && elapsed < 450) {
        const sceneParams = this.host.getSceneParams();
        const hit = raycastAtScreen(upX, upY, this.host.canvas, this.host.camera, sceneParams);
        const activeRoute = this.host.getActiveRoute();
        if (hit && activeRoute) {
          this.host.pushHistory(activeRoute.points);
          const newPoint: LidarRouteOverlayPoint = {
            lat: hit.lat,
            lon: hit.lon,
            elevationM: hit.elevationM,
          };
          const newPoints = [...activeRoute.points, newPoint];
          this.host.setSelectedPointIndex(newPoints.length - 1);
          this.host.onPointsChangeCommit(newPoints, 'append_point');
          this.host.notifyStateChange();
          this.host.updateOverlay();
          this.host.requestRender();
        }
      }
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.host.selectedPointIndex != null) {
        e.preventDefault();
        this.host.deleteSelectedPoint();
      }
    } else if (e.key === 'Escape') {
      if (this.host.editMode) {
        this.host.setEditMode(false);
      } else if (this.host.selectedPointIndex != null) {
        this.host.setSelectedPointIndex(null);
        this.host.notifyStateChange();
        this.host.updateOverlay();
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) {
        this.host.redo();
      } else {
        this.host.undo();
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.host.redo();
    }
  };

  public destroy(): void {
    this.host.camera.setLocked(false);
    const canvas = this.host.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    canvas.removeEventListener('mousedown', this.onMouseDownCapture, { capture: true });
    canvas.removeEventListener('contextmenu', this.onContextMenu, { capture: true });
    window.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    window.removeEventListener('mousemove', this.onMouseMoveCapture, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('mouseup', this.onMouseUpCapture, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown);
  }
}
