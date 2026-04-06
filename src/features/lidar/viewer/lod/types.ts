// ============================================
// Octree LOD — Types & Constants
// ============================================

/** Max points per leaf before splitting */
export const MAX_POINTS_PER_NODE = 50_000;

/** Maximum octree depth (prevents infinite subdivision) */
export const MAX_DEPTH = 16;

/** Occupancy grid cells per axis for voxel sampling (64³ = 262K bits = 32KB per node) */
export const OCCUPANCY_GRID_SIZE = 64;

/** Screen-space size (px) below which a node renders at its LOD level instead of recursing */
export const MIN_NODE_SIZE_PX = 45;

/** LOD cross-fade: nodes below this screen-size render only voxels */
export const LOD_FADE_LOW = 35;

/** LOD cross-fade: nodes above this screen-size render only leaves */
export const LOD_FADE_HIGH = 55;

/** Hysteresis factor — refined nodes use this fraction of threshold to merge back. */
export const HYSTERESIS_FACTOR = 0.55;

/** Temporal coherence: reuse visibility if camera moved less than this (meters) */
export const TEMPORAL_POS_THRESHOLD = 1.5;

/** Temporal coherence: reuse visibility if camera rotated less than this (degrees) */
export const TEMPORAL_ROT_THRESHOLD = 1.0;

/** Adaptive budget: initial point budget */
export const INITIAL_POINT_BUDGET = 8_000_000;

/** Adaptive budget: minimum floor */
export const MIN_POINT_BUDGET = 3_000_000;

/** Adaptive budget: maximum ceiling */
export const MAX_POINT_BUDGET = 25_000_000;

/** Rolling frame window for adaptive FPS tracking */
export const FRAME_WINDOW = 8;

/** Target frame time in ms (60fps) */
export const TARGET_FRAME_MS = 16.6;

/** Minimum density floor (never remove more than 85% of points) */
export const MIN_DENSITY = 0.15;

/** Temporal density blend rate (lerp towards target density each frame) */
export const DENSITY_BLEND_RATE = 0.3;

/** Platform-dependent GPU/memory profile */
export interface PlatformProfile {
  initialBudget: number;
  maxBudget: number;
  maxCanvasDim: number;
  dprCap: number;
  isApple: boolean;
}

/** Axis-aligned bounding box */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/** Octree node (CPU-side, used during build and traversal) */
export interface OctreeNode {
  id: number;
  depth: number;
  aabb: AABB;
  children: (OctreeNode | null)[];
  isLeaf: boolean;
  pointOffset: number;
  pointCount: number;
  voxelOffset: number;
  voxelCount: number;
  subtreePointCount: number;
}

/** Serializable octree node for transfer between worker and main thread */
export interface SerializedNode {
  id: number;
  depth: number;
  aabb: AABB;
  children: (SerializedNode | null)[];
  isLeaf: boolean;
  pointOffset: number;
  pointCount: number;
  voxelOffset: number;
  voxelCount: number;
  subtreePointCount: number;
}

/** Flattened octree ready for GPU upload */
export interface FlatOctree {
  root: SerializedNode;
  leafPositions: Float32Array;
  leafColors: Uint8Array;
  voxelPositions: Float32Array;
  voxelColors: Uint8Array;
  totalLeafPoints: number;
  totalVoxelSamples: number;
  maxDepthReached: number;
  nodeCount: number;
}

/** Visible node descriptor used by renderer to issue draw calls */
export interface VisibleNode {
  offset: number;
  count: number;
  isVoxel: boolean;
  depth: number;
  screenSize: number;
  density: number;
  /** Cross-fade alpha for smooth LOD transitions (0 = fully transparent, 1 = fully opaque) */
  fadeAlpha: number;
}

/** Camera state for temporal coherence checks */
export interface CameraState {
  posX: number; posY: number; posZ: number;
  fwdX: number; fwdY: number; fwdZ: number;
}

/** Messages from octree worker */
export type OctreeWorkerResponse =
  | { type: 'progress'; message: string; percent: number }
  | {
      type: 'done';
      root: SerializedNode;
      leafPositions: Float32Array;
      leafColors: Uint8Array;
      voxelPositions: Float32Array;
      voxelColors: Uint8Array;
      totalLeafPoints: number;
      totalVoxelSamples: number;
      maxDepthReached: number;
      nodeCount: number;
    }
  | { type: 'error'; message: string };
