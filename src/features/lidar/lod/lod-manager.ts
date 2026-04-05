import type { OctreeNode, CameraState, VisibleNode } from './types';
import {
  MIN_SCREEN_SIZE, HYSTERESIS_RATIO,
  INITIAL_BUDGET, MIN_BUDGET, MAX_BUDGET, FPS_WINDOW,
} from './types';
import { extractFrustumPlanes, testAABB, screenSpaceSize } from './frustum';

export class LodManager {
  private budget = INITIAL_BUDGET;
  private frameTimes: number[] = [];
  private lastVisible = new Set<OctreeNode>();

  /**
   * Traverse the octree, return visible nodes + whether to use voxels or leaves.
   */
  selectVisible(root: OctreeNode, camera: CameraState): VisibleNode[] {
    const planes = extractFrustumPlanes(camera.viewProjMatrix);
    const result: VisibleNode[] = [];
    let totalPoints = 0;
    const newVisible = new Set<OctreeNode>();

    const stack: OctreeNode[] = [root];

    while (stack.length > 0) {
      const node = stack.pop()!;

      // Frustum cull
      const cull = testAABB(planes, node.aabb);
      if (cull === 'outside') continue;

      // Screen-space size
      const size = screenSpaceSize(
        node.aabb,
        camera.viewProjMatrix,
        camera.viewportWidth,
        camera.viewportHeight,
      );

      // Hysteresis: if node was visible last frame, use lower threshold
      const threshold = this.lastVisible.has(node)
        ? MIN_SCREEN_SIZE * HYSTERESIS_RATIO
        : MIN_SCREEN_SIZE;

      const isLeaf = node.pointCount > 0;

      if (isLeaf || size < threshold) {
        // Render at this LOD
        newVisible.add(node);

        if (isLeaf) {
          // Budget check
          if (totalPoints + node.pointCount <= this.budget) {
            result.push({ node, useVoxels: false, screenSize: size });
            totalPoints += node.pointCount;
          }
        } else if (node.voxelCount > 0) {
          if (totalPoints + node.voxelCount <= this.budget) {
            result.push({ node, useVoxels: true, screenSize: size });
            totalPoints += node.voxelCount;
          }
        }
        continue;
      }

      // Refine: push children
      let hasChild = false;
      for (let i = 7; i >= 0; i--) {
        const child = node.children[i];
        if (child) {
          stack.push(child);
          hasChild = true;
        }
      }

      // Gap-fill: if no children contribute, use voxels
      if (!hasChild && node.voxelCount > 0) {
        newVisible.add(node);
        if (totalPoints + node.voxelCount <= this.budget) {
          result.push({ node, useVoxels: true, screenSize: size });
          totalPoints += node.voxelCount;
        }
      }
    }

    this.lastVisible = newVisible;
    return result;
  }

  /**
   * Call after each frame with the frame time in ms.
   * Adapts the point budget based on FPS.
   */
  adaptBudget(frameTimeMs: number): void {
    this.frameTimes.push(frameTimeMs);
    if (this.frameTimes.length > FPS_WINDOW) {
      this.frameTimes.shift();
    }
    if (this.frameTimes.length < FPS_WINDOW) return;

    const avgMs = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const fps = 1000 / avgMs;

    if (fps < 30 && this.budget > MIN_BUDGET) {
      this.budget = Math.max(MIN_BUDGET, Math.floor(this.budget * 0.85));
    } else if (fps > 55 && this.budget < MAX_BUDGET) {
      this.budget = Math.min(MAX_BUDGET, Math.floor(this.budget * 1.1));
    }
  }

  getBudget(): number {
    return this.budget;
  }
}
