import type { DetectedCrs, PointCloudBounds } from '../../types';
import type { LidarRouteOverlayItem } from '../../lib/routeOverlaySync';
import type { RouteEditTool } from './routeEditorController';

export type { LidarRouteOverlayItem, LidarRouteOverlayPoint, LidarRouteOverlayState, LidarRouteSyncMessage } from '../../lib/routeOverlaySync';
export type { RouteEditTool, RouteEditorState } from './routeEditorController';

export interface LidarRouteMeshGeometry {
  /** Interleaved or separate position buffer: x, y, z (local viewer space) */
  vertices: Float32Array;
  /** RGBA byte colors per vertex: r, g, b, a (0..255) */
  colors: Uint8Array;
  /** Triangle indices */
  indices: Uint32Array;
  /** Total vertex count */
  vertexCount: number;
  /** Total index count (draw count) */
  indexCount: number;
}

export interface ViewerRouteRenderOptions {
  /** Ribbon width in meters in 3D world space (default: 3.2m) */
  ribbonWidthM?: number;
  /** Elevation offset above ground in meters to prevent z-fighting (default: 0.65m) */
  elevationBiasM?: number;
  /** Global opacity multiplier (0..1) */
  opacityScale?: number;
  /** Whether the route overlay is enabled */
  enabled?: boolean;
}

export interface ViewerRouteSceneParams {
  bounds: PointCloudBounds;
  crs: DetectedCrs;
  centerX: number;
  centerY: number;
  centerZ: number;
  heightGrid?: Float32Array | null;
  gridWidth?: number;
  gridHeight?: number;
}

export interface ViewerRouteState {
  enabled: boolean;
  opacity: number; // 0..100
  ribbonWidthM: number; // 1..10
  selectedRouteId: string | null;
  routes: LidarRouteOverlayItem[];
  activeRoute: LidarRouteOverlayItem | null;
  editMode: boolean;
  activeTool: RouteEditTool;
  selectedPointIndex: number | null;
  canUndo: boolean;
  canRedo: boolean;
}
