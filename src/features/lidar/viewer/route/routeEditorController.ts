import { geoToLocal3D, projectToScreen } from './terrainRaycaster';
import {
  RouteHandlesOverlay,
  type HoverReticleInfo,
  type InsertGhostHandle,
} from './routeHandlesOverlay';
import type { CameraController } from '../camera';
import type {
  LidarRouteOverlayItem,
  LidarRouteOverlayPoint,
  ViewerRouteSceneParams,
} from './types';
import { RouteEditorHistory } from './routeEditorHistory';
import { buildDraggingHandleInfo, buildRouteHandles } from './routeOverlaySync';
import { RouteEditorInputManager, type RouteEditorHost } from './routeEditorEvents';

export type RouteEditTool = 'move' | 'insert' | 'append' | 'delete';

export interface RouteEditorState {
  editMode: boolean;
  activeTool: RouteEditTool;
  selectedPointIndex: number | null;
  pointCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface RouteEditorControllerOptions {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  camera: CameraController;
  getSceneParams: () => ViewerRouteSceneParams;
  getActiveRoute: () => LidarRouteOverlayItem | null;
  onPointsChangeLive: (points: LidarRouteOverlayPoint[]) => void;
  onPointsChangeCommit: (points: LidarRouteOverlayPoint[], actionName?: string) => void;
  onRequestRender: () => void;
  onStateChange?: (state: RouteEditorState) => void;
}

export class RouteEditorController implements RouteEditorHost {
  public canvas: HTMLCanvasElement;
  public camera: CameraController;
  public getSceneParams: () => ViewerRouteSceneParams;
  public getActiveRoute: () => LidarRouteOverlayItem | null;
  public onPointsChangeLive: (points: LidarRouteOverlayPoint[]) => void;
  public onPointsChangeCommit: (points: LidarRouteOverlayPoint[], actionName?: string) => void;
  public requestRender: () => void;
  private stateChangeListeners: Array<(state: RouteEditorState) => void> = [];

  private overlay: RouteHandlesOverlay;
  private history = new RouteEditorHistory(50);
  private inputManager: RouteEditorInputManager;

  public editMode = true;
  public activeTool: RouteEditTool = 'move';
  public selectedPointIndex: number | null = null;
  public hoveredPointIndex: number | null = null;
  public hoveredGhost: InsertGhostHandle | null = null;
  public hoverReticle: HoverReticleInfo | null = null;

  public isDragging = false;
  public dragPointIndex: number | null = null;
  public dragInitialPoints: LidarRouteOverlayPoint[] | null = null;

  constructor(opts: RouteEditorControllerOptions) {
    this.canvas = opts.canvas;
    this.camera = opts.camera;
    this.getSceneParams = opts.getSceneParams;
    this.getActiveRoute = opts.getActiveRoute;
    this.onPointsChangeLive = opts.onPointsChangeLive;
    this.onPointsChangeCommit = opts.onPointsChangeCommit;
    this.requestRender = opts.onRequestRender;

    if (opts.onStateChange) {
      this.stateChangeListeners.push(opts.onStateChange);
    }

    this.overlay = new RouteHandlesOverlay({
      container: opts.container,
      sceneCanvas: opts.canvas,
    });
    this.overlay.setEditMode(true);

    this.inputManager = new RouteEditorInputManager(this);
  }

  public onStateChange(cb: (state: RouteEditorState) => void): () => void {
    this.stateChangeListeners.push(cb);
    cb(this.getState());
    return () => {
      this.stateChangeListeners = this.stateChangeListeners.filter((l) => l !== cb);
    };
  }

  public getState(): RouteEditorState {
    const activeRoute = this.getActiveRoute();
    return {
      editMode: this.editMode,
      activeTool: this.activeTool,
      selectedPointIndex: this.selectedPointIndex,
      pointCount: activeRoute?.points?.length ?? 0,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
  }

  public notifyStateChange(): void {
    const state = this.getState();
    for (const listener of this.stateChangeListeners) {
      try {
        listener(state);
      } catch (err) {
        console.warn('[RouteEditorController] State listener error:', err);
      }
    }
  }

  public setEditMode(enabled: boolean): void {
    if (this.editMode === enabled) return;
    this.editMode = enabled;
    if (enabled) {
      this.activeTool = 'append';
    } else {
      this.activeTool = 'move';
      this.hoverReticle = null;
      this.isDragging = false;
      this.dragPointIndex = null;
      this.canvas.style.cursor = 'default';
    }
    this.overlay.setEditMode(enabled);
    this.notifyStateChange();
    this.updateOverlay();
    this.requestRender();
  }

  public setActiveTool(tool: RouteEditTool): void {
    this.activeTool = tool;
    this.notifyStateChange();
    this.updateOverlay();
  }

  public setSelectedPointIndex(index: number | null): void {
    this.selectedPointIndex = index;
    this.notifyStateChange();
    this.updateOverlay();
  }

  public pushHistory(points: LidarRouteOverlayPoint[]): void {
    this.history.push(points);
    this.notifyStateChange();
  }

  public undo(): boolean {
    const currentRoute = this.getActiveRoute();
    if (!currentRoute?.points) return false;

    const previousPoints = this.history.undo(currentRoute.points);
    if (!previousPoints) return false;

    this.onPointsChangeCommit(previousPoints, 'undo');
    this.notifyStateChange();
    this.updateOverlay();
    this.requestRender();
    return true;
  }

  public redo(): boolean {
    const currentRoute = this.getActiveRoute();
    if (!currentRoute?.points) return false;

    const nextPoints = this.history.redo(currentRoute.points);
    if (!nextPoints) return false;

    this.onPointsChangeCommit(nextPoints, 'redo');
    this.notifyStateChange();
    this.updateOverlay();
    this.requestRender();
    return true;
  }

  public deleteSelectedPoint(): boolean {
    if (this.selectedPointIndex == null) return false;
    const currentRoute = this.getActiveRoute();
    if (!currentRoute || !currentRoute.points) return false;

    const idx = this.selectedPointIndex;
    if (idx < 0 || idx >= currentRoute.points.length) return false;

    this.history.push(currentRoute.points);
    const newPoints = currentRoute.points.filter((_, i) => i !== idx);
    this.selectedPointIndex = null;
    this.hoveredPointIndex = null;
    this.hoveredGhost = null;

    this.onPointsChangeCommit(newPoints, 'delete_point');
    this.notifyStateChange();
    this.updateOverlay();
    this.requestRender();
    return true;
  }

  public reverseRoute(): boolean {
    const currentRoute = this.getActiveRoute();
    if (!currentRoute || !currentRoute.points || currentRoute.points.length < 2) return false;

    this.history.push(currentRoute.points);
    const reversed = [...currentRoute.points].reverse();
    this.selectedPointIndex = null;

    this.onPointsChangeCommit(reversed, 'reverse_route');
    this.notifyStateChange();
    this.updateOverlay();
    this.requestRender();
    return true;
  }

  public snapAllPointsToTerrain(): boolean {
    const currentRoute = this.getActiveRoute();
    if (!currentRoute || !currentRoute.points || currentRoute.points.length === 0) return false;

    const sceneParams = this.getSceneParams();
    this.history.push(currentRoute.points);

    const snapped = currentRoute.points.map((pt) => {
      const { elevationM } = geoToLocal3D(pt.lat, pt.lon, sceneParams, 0.65);
      return {
        ...pt,
        elevationM,
      };
    });

    this.onPointsChangeCommit(snapped, 'snap_to_terrain');
    this.notifyStateChange();
    this.updateOverlay();
    this.requestRender();
    return true;
  }

  /**
   * Recomputes screen projected handles and renders overlay.
   */
  public updateOverlay(): void {
    const activeRoute = this.getActiveRoute();
    if (!activeRoute || !activeRoute.points || activeRoute.points.length === 0) {
      this.overlay.render([], null, null, this.editMode && this.activeTool === 'append' ? this.hoverReticle : null);
      return;
    }

    this.overlay.setRouteColor(activeRoute.color);
    const sceneParams = this.getSceneParams();

    const handles = buildRouteHandles(
      activeRoute.points,
      this.selectedPointIndex,
      this.hoveredPointIndex,
      sceneParams,
      this.canvas,
      this.camera,
    );

    const draggingInfo = buildDraggingHandleInfo(
      this.dragPointIndex,
      this.isDragging,
      handles,
      activeRoute.points.length,
    );

    let reticleToRender = this.hoverReticle;
    if (reticleToRender?.groundPoints3D && reticleToRender.groundPoints3D.length > 0) {
      const width = this.canvas.clientWidth || window.innerWidth;
      const height = this.canvas.clientHeight || window.innerHeight;
      const viewMat = this.camera.getViewMatrix();
      const projMat = this.camera.getProjMatrix();

      const reprojected = reticleToRender.groundPoints3D.map(([lx, ly, lz]) =>
        projectToScreen(lx, ly, lz, width, height, viewMat, projMat),
      );

      reticleToRender = {
        ...reticleToRender,
        groundPoints: reprojected,
      };
    }

    this.overlay.render(handles, this.hoveredGhost, draggingInfo, reticleToRender);
  }

  public destroy(): void {
    this.inputManager.destroy();
    this.overlay.destroy();
    this.stateChangeListeners = [];
  }
}
