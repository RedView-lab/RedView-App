import type { DetectedCrs, PointCloudBounds } from '../../types';
import type { LidarRouteOverlayItem } from '../../lib/routeOverlaySync';
import type { RouteEditTool } from './routeEditorController';

export type { LidarRouteOverlayItem, LidarRouteOverlayPoint,   } from '../../lib/routeOverlaySync';
;

export interface LidarRouteMeshGeometry {
  /** Buffer de positions entrelacé ou séparé : x, y, z (espace local du viewer) */
  vertices: Float32Array;
  /** Couleurs RGBA en octets par sommet : r, g, b, a (0..255) */
  colors: Uint8Array;
  /** Indices des triangles */
  indices: Uint32Array;
  /** Nombre total de sommets */
  vertexCount: number;
  /** Nombre total d'indices (nombre à dessiner) */
  indexCount: number;
}

export interface ViewerRouteRenderOptions {
  /** Ribbon width in meters in 3D world space (default: 3.2m) */
  ribbonWidthM?: number;
  /** Décalage d'altitude au-dessus du sol en mètres pour éviter le z-fighting (par défaut : 0,65 m) */
  elevationBiasM?: number;
  /** Multiplicateur d'opacité global (0..1) */
  opacityScale?: number;
  /** Indique si la surcouche des tracés est activée */
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
  /**
   * Soustrait des échantillons de heightGrid pour obtenir le Y du renderer : 0
   * quand la grille est déjà centrée sur centerZ (viewer WebGPU), centerZ quand
   * elle contient des altitudes absolues (viewer WebGL).
   */
  heightGridOffsetZ?: number;
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
