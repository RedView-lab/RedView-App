import { buildLidarRouteMesh } from './builder';
import { loadLidarRouteOverlay, subscribeToLidarRouteOverlay } from './storage';
import {
  broadcastLidarRouteCreate,
  broadcastLidarRouteDelete,
  broadcastLidarRouteEdit,
  broadcastLidarRouteRename,
} from '../../lib/routeOverlaySync';
import { RouteEditorController, type RouteEditTool, type RouteEditorState } from './routeEditorController';
import type { CameraController } from '../camera';
import type {
  LidarRouteMeshGeometry,
  LidarRouteOverlayItem,
  ViewerRouteRenderOptions,
  ViewerRouteSceneParams,
  ViewerRouteState,
} from './types';

const DEFAULT_ROUTE_PALETTE = [
  '#E53935', // Rouge dynamique
  '#00E5FF', // Cyan électrique
  '#76FF03', // Lime éclatant
  '#FF9100', // Ambre / orange vif
  '#D500F9', // Magenta néon
  '#FFD600', // Jaune or
  '#2979FF', // Bleu saphir
];

export interface ViewerRouteControllerOptions {
  sceneParams: ViewerRouteSceneParams;
  onMeshChange: (geometry: LidarRouteMeshGeometry | null) => void;
  onRequestRender: () => void;
  onStateChange?: (state: ViewerRouteState) => void;
  canvas?: HTMLCanvasElement;
  container?: HTMLElement;
  camera?: CameraController;
}

export class ViewerRouteController {
  private sceneParams: ViewerRouteSceneParams;
  private onMeshChange: (geometry: LidarRouteMeshGeometry | null) => void;
  private onRequestRender: () => void;
  private stateChangeListeners: Array<(state: ViewerRouteState) => void> = [];

  private enabled = true;
  private opacity = 100; // 0..100
  private ribbonWidthM = 3.2; // meters
  private routes: LidarRouteOverlayItem[] = [];
  private selectedRouteId: string | null = null;

  private editor: RouteEditorController | null = null;
  private editorState: RouteEditorState = {
    editMode: false,
    activeTool: 'move',
    selectedPointIndex: null,
    pointCount: 0,
    canUndo: false,
    canRedo: false,
  };

  private unsubscribeStorage: (() => void) | null = null;
  private currentGeometry: LidarRouteMeshGeometry | null = null;

  constructor(opts: ViewerRouteControllerOptions) {
    this.sceneParams = opts.sceneParams;
    this.onMeshChange = opts.onMeshChange;
    this.onRequestRender = opts.onRequestRender;

    if (opts.onStateChange) {
      this.stateChangeListeners.push(opts.onStateChange);
    }

    // Load initial routes from storage
    const initialOverlay = loadLidarRouteOverlay();
    if (initialOverlay && initialOverlay.routes) {
      this.routes = initialOverlay.routes;
      if (this.routes.length > 0) {
        this.selectedRouteId = this.routes[0]?.id ?? null;
      }
    }

    // Initialize 3D Route Editor if canvas & camera provided
    if (opts.canvas && opts.camera) {
      this.attachEditor(opts.canvas, opts.container || document.body, opts.camera);
    }

    // Subscribe to real-time updates across tabs & RedView main window
    this.unsubscribeStorage = subscribeToLidarRouteOverlay((msg) => {
      if ('type' in msg) {
        // Skip self-originating updates
        if (msg.source === 'lidar_viewer') return;

        if (msg.type === 'UPDATE_ROUTE_POINTS') {
          const targetRoute = this.routes.find((r) => r.id === msg.routeId);
          if (targetRoute) {
            targetRoute.points = msg.points;
            this.rebuildAndEmit(true);
            this.editor?.updateOverlay();
          }
        } else if (msg.type === 'CREATE_ROUTE') {
          if (!this.routes.some((r) => r.id === msg.route.id)) {
            this.routes.push(msg.route);
            if (!this.selectedRouteId) {
              this.selectedRouteId = msg.route.id;
            }
            this.rebuildAndEmit(true);
            this.editor?.updateOverlay();
          }
        } else if (msg.type === 'RENAME_ROUTE') {
          const targetRoute = this.routes.find((r) => r.id === msg.routeId);
          if (targetRoute) {
            targetRoute.name = msg.name;
            this.notifyStateChange();
          }
        } else if (msg.type === 'DELETE_ROUTE') {
          this.routes = this.routes.filter((r) => r.id !== msg.routeId);
          if (this.selectedRouteId === msg.routeId) {
            this.selectedRouteId = this.routes[0]?.id ?? null;
          }
          this.rebuildAndEmit(true);
          this.editor?.updateOverlay();
        }
      } else if ('routes' in msg && Array.isArray(msg.routes)) {
        if (msg.source === 'lidar_viewer') return;
        const incomingRoutes = msg.routes;
        const currentActive = this.getActiveRoute();
        if (currentActive && !incomingRoutes.some((r) => r.id === currentActive.id)) {
          this.routes = [...incomingRoutes, currentActive];
        } else {
          this.routes = incomingRoutes;
        }
        if (!this.selectedRouteId && this.routes.length > 0) {
          this.selectedRouteId = this.routes[0]?.id ?? null;
        }
        this.rebuildAndEmit(true);
        this.editor?.updateOverlay();
      }
    });

    // Build initial geometry
    this.rebuildAndEmit(false);
  }

  public attachEditor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    camera: CameraController,
  ): void {
    if (this.editor) {
      this.editor.destroy();
    }

    this.editor = new RouteEditorController({
      canvas,
      container,
      camera,
      getSceneParams: () => this.sceneParams,
      getActiveRoute: () => this.getActiveRoute(),
      onPointsChangeLive: (points) => {
        const active = this.getActiveRoute();
        if (active) {
          active.points = points;
          this.rebuildAndEmit(true, false);
        }
      },
      onPointsChangeCommit: (points, actionName) => {
        const active = this.getActiveRoute();
        if (active) {
          active.points = points;
          this.rebuildAndEmit(true, true);
          // Broadcast to RedView main application
          broadcastLidarRouteEdit(active.id, points, 'lidar_viewer', actionName);
        }
      },
      onRequestRender: this.onRequestRender,
      onStateChange: (state) => {
        this.editorState = state;
        this.notifyStateChange();
      },
    });

    this.editorState = this.editor.getState();
  }

  public onStateChange(cb: (state: ViewerRouteState) => void): () => void {
    this.stateChangeListeners.push(cb);
    cb(this.getState());
    return () => {
      this.stateChangeListeners = this.stateChangeListeners.filter((l) => l !== cb);
    };
  }

  public getActiveRoute(): LidarRouteOverlayItem | null {
    return (
      this.routes.find((r) => r.id === this.selectedRouteId) ??
      this.routes[0] ??
      null
    );
  }

  public getState(): ViewerRouteState {
    const activeRoute = this.getActiveRoute();

    return {
      enabled: this.enabled,
      opacity: this.opacity,
      ribbonWidthM: this.ribbonWidthM,
      selectedRouteId: this.selectedRouteId,
      routes: this.routes,
      activeRoute,
      editMode: this.editorState.editMode,
      activeTool: this.editorState.activeTool,
      selectedPointIndex: this.editorState.selectedPointIndex,
      canUndo: this.editorState.canUndo,
      canRedo: this.editorState.canRedo,
    };
  }

  private notifyStateChange(): void {
    const state = this.getState();
    for (const listener of this.stateChangeListeners) {
      try {
        listener(state);
      } catch (err) {
        console.warn('[ViewerRouteController] Error in state listener:', err);
      }
    }
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled && this.editor) {
      this.editor.setEditMode(false);
    }
    this.rebuildAndEmit();
  }

  public setOpacity(opacity: number): void {
    const clamped = Math.max(0, Math.min(100, opacity));
    if (this.opacity === clamped) return;
    this.opacity = clamped;
    this.rebuildAndEmit();
  }

  public setRibbonWidth(widthM: number): void {
    const clamped = Math.max(0.5, Math.min(12, widthM));
    if (this.ribbonWidthM === clamped) return;
    this.ribbonWidthM = clamped;
    this.rebuildAndEmit();
  }

  public setSelectedRouteId(id: string | null): void {
    if (this.selectedRouteId === id) return;
    this.selectedRouteId = id;
    this.rebuildAndEmit();
    this.editor?.updateOverlay();
  }

  public createRoute(name?: string, color?: string): LidarRouteOverlayItem {
    const routeIndex = this.routes.length + 1;
    const defaultColor =
      DEFAULT_ROUTE_PALETTE[(routeIndex - 1) % DEFAULT_ROUTE_PALETTE.length] ?? '#E53935';
    const newRoute: LidarRouteOverlayItem = {
      id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name?.trim() || `Trace 3D ${routeIndex}`,
      color: color || defaultColor,
      opacity: 1,
      visible: true,
      points: [],
    };

    this.routes.push(newRoute);
    this.selectedRouteId = newRoute.id;
    this.enabled = true;

    // Immediately enter 3D drawing mode
    this.setEditMode(true);
    this.setActiveTool('append');

    // Broadcast creation to RedView main application & sync storage
    broadcastLidarRouteCreate(newRoute, 'lidar_viewer');

    this.rebuildAndEmit(true);
    this.editor?.updateOverlay();
    return newRoute;
  }

  public renameRoute(id: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    const route = this.routes.find((r) => r.id === id);
    if (!route) return false;

    route.name = trimmed;
    this.notifyStateChange();
    broadcastLidarRouteRename(id, trimmed, 'lidar_viewer');
    return true;
  }

  public setRouteColor(id: string, color: string): boolean {
    const route = this.routes.find((r) => r.id === id);
    if (!route) return false;
    route.color = color;
    this.rebuildAndEmit(true);
    return true;
  }

  public setRouteOpacity(id: string, opacityPercent: number): boolean {
    const route = this.routes.find((r) => r.id === id);
    if (!route) return false;
    route.opacity = Math.max(0, Math.min(100, opacityPercent)) / 100;
    this.rebuildAndEmit(true);
    return true;
  }

  public toggleRouteVisibility(id: string): boolean {
    const route = this.routes.find((r) => r.id === id);
    if (!route) return false;
    route.visible = !route.visible;
    this.rebuildAndEmit(true);
    return true;
  }

  public deleteRoute(id: string): boolean {
    const exists = this.routes.some((r) => r.id === id);
    if (!exists) return false;

    this.routes = this.routes.filter((r) => r.id !== id);
    if (this.selectedRouteId === id) {
      this.selectedRouteId = this.routes[0]?.id ?? null;
    }
    if (this.routes.length === 0) {
      this.setEditMode(false);
    }

    broadcastLidarRouteDelete(id, 'lidar_viewer');
    this.rebuildAndEmit(true);
    this.editor?.updateOverlay();
    return true;
  }

  public duplicateRoute(id: string): LidarRouteOverlayItem | null {
    const source = this.routes.find((r) => r.id === id);
    if (!source) return null;

    const newRoute: LidarRouteOverlayItem = {
      ...structuredClone(source),
      id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${source.name} (copie)`,
    };

    this.routes.push(newRoute);
    this.selectedRouteId = newRoute.id;
    broadcastLidarRouteCreate(newRoute, 'lidar_viewer');
    this.rebuildAndEmit(true);
    this.editor?.updateOverlay();
    return newRoute;
  }

  public exportRouteGpx(id: string): void {
    const route = this.routes.find((r) => r.id === id) ?? this.getActiveRoute();
    if (!route || !route.points || route.points.length === 0) return;

    const safeName = (route.name || 'trace-lidar').replace(/[<>&'"]/g, '_');
    const trkpts = route.points
      .map((pt) => {
        const eleTag = Number.isFinite(pt.elevationM)
          ? `<ele>${Number(pt.elevationM).toFixed(2)}</ele>`
          : '';
        return `      <trkpt lat="${pt.lat}" lon="${pt.lon}">${eleTag}</trkpt>`;
      })
      .join('\n');

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RedView LiDAR HD" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${safeName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.gpx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  // ── 3D Route Editor Proxy Methods ──────────────────────────────────────────

  public setEditMode(enabled: boolean): void {
    this.editor?.setEditMode(enabled);
  }

  public setActiveTool(tool: RouteEditTool): void {
    this.editor?.setActiveTool(tool);
  }

  public setSelectedPointIndex(index: number | null): void {
    this.editor?.setSelectedPointIndex(index);
  }

  public undo(): boolean {
    return this.editor?.undo() ?? false;
  }

  public redo(): boolean {
    return this.editor?.redo() ?? false;
  }

  public deleteSelectedPoint(): boolean {
    return this.editor?.deleteSelectedPoint() ?? false;
  }

  public reverseActiveRoute(): boolean {
    return this.editor?.reverseRoute() ?? false;
  }

  public snapAllPointsToTerrain(): boolean {
    return this.editor?.snapAllPointsToTerrain() ?? false;
  }

  public updateOverlay(): void {
    this.editor?.updateOverlay();
  }

  public updateSceneParams(params: Partial<ViewerRouteSceneParams>): void {
    this.sceneParams = { ...this.sceneParams, ...params };
    this.rebuildAndEmit(true);
    this.editor?.updateOverlay();
  }

  private rebuildAndEmit(notifyRender = true, notifyState = true): void {
    if (notifyState) {
      this.notifyStateChange();
    }

    if (!this.enabled || this.routes.length === 0) {
      this.currentGeometry = null;
      this.onMeshChange(null);
      if (notifyRender) {
        this.onRequestRender?.();
      }
      return;
    }

    const renderOpts: ViewerRouteRenderOptions = {
      ribbonWidthM: this.ribbonWidthM,
      opacityScale: this.opacity / 100,
      enabled: this.enabled,
    };

    const geometry = buildLidarRouteMesh(this.routes, this.sceneParams, renderOpts);
    this.currentGeometry = geometry;
    this.onMeshChange(geometry);
    if (notifyRender) {
      this.onRequestRender?.();
    }
  }

  public getGeometry(): LidarRouteMeshGeometry | null {
    return this.currentGeometry;
  }

  public destroy(): void {
    if (this.unsubscribeStorage) {
      this.unsubscribeStorage();
      this.unsubscribeStorage = null;
    }
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    this.stateChangeListeners = [];
    this.currentGeometry = null;
    this.onMeshChange(null);
  }
}
