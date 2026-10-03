// ============================================
// LiDAR viewer tools — shared types
// ============================================
//
// Frames used by every tool:
//  - proj: CRS metres (x east, y north) + absolute altitude (m);
//  - local: render frame, centred on the scene (x east, y up, z = −north).

export type Vec3 = [number, number, number];

/** A point picked in the scene (point cloud first, then the terrain model). */
export interface ScenePick {
  /** Render-frame position. */
  local: Vec3;
  projX: number;
  projY: number;
  /** Altitude of the picked surface (point or ground), m. */
  altitudeM: number;
  lon: number;
  lat: number;
  /** `points`: a LiDAR return; `terrain`: the ground model (DTM). */
  source: 'points' | 'terrain';
  /** ASPRS class of the picked return (`null` on the terrain model). */
  classification: number | null;
  /** Ground altitude under the pick (DTM), m. */
  groundAltitudeM: number | null;
}

/** Tools started from the context menu or the keyboard. */
export type ToolId =
  | 'distance'
  | 'height'
  | 'area'
  | 'profile'
  | 'fallLine'
  | 'avalanche'
  | 'viewshed'
  | 'pin';

/** Tools drawn vertex by vertex (finished with a right click or Enter). */
export type DrawingToolId = Extract<ToolId, 'distance' | 'height' | 'area' | 'profile'>;

export function isDrawingTool(tool: ToolId): tool is DrawingToolId {
  return tool === 'distance' || tool === 'height' || tool === 'area' || tool === 'profile';
}

/** RGBA, 0..255. */
export type Rgba = [number, number, number, number];
