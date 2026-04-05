export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface OctreeNode {
  aabb: AABB;
  depth: number;
  pointStart: number;
  pointCount: number;
  /** Voxel-sampled points for this inner node (coarser LOD) */
  voxelStart: number;
  voxelCount: number;
  children: (OctreeNode | null)[];
  /** Total points in this node + all descendants */
  subtreeCount: number;
}

export interface FlatOctree {
  root: OctreeNode;
  /** Contiguous arrays for GPU upload */
  positions: Float32Array;
  colors: Uint8Array;
  normals: Float32Array;
  totalLeafPoints: number;
  totalVoxelPoints: number;
}

export interface VisibleNode {
  node: OctreeNode;
  useVoxels: boolean;
  screenSize: number;
}

export interface CameraState {
  viewProjMatrix: Float32Array;
  cameraPos: [number, number, number];
  viewportWidth: number;
  viewportHeight: number;
}

export const MAX_DEPTH = 14;
export const MAX_LEAF_POINTS = 50_000;
export const OCCUPANCY_GRID_RES = 64;
export const MIN_SCREEN_SIZE = 20;
export const HYSTERESIS_RATIO = 0.35;
export const INITIAL_BUDGET = 8_000_000;
export const MIN_BUDGET = 3_000_000;
export const MAX_BUDGET = 25_000_000;
export const FPS_WINDOW = 12;
