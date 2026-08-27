import type { SerializedNode, VisibleNode } from './types';
import { HYSTERESIS_FACTOR, MIN_DENSITY } from './types';
import {
  frustumTestAABB,
  screenSpaceSize,
  OUTSIDE,
  INSIDE,
  type FrustumPlanes,
} from './frustum';

export interface LodCollectContext {
  planes: FrustumPlanes;
  viewProj: Float32Array;
  vpW: number;
  vpH: number;
  camX: number;
  camY: number;
  camZ: number;
  cachedMinScreenPx: number;
  cachedFadeLowBase: number;
  cachedFadeHighBase: number;
  refinedLastFrame: Uint8Array;
  refinedThisFrame: Uint8Array;
  acquireNode: () => VisibleNode;
  visibleNodes: VisibleNode[];
  visiblePointCount: number;
  voxelMinDepth: number;
  frustumCulled: number;
  lodSkipped: number;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function collectVisibleOctreeNode(
  node: SerializedNode,
  ctx: LodCollectContext,
  testFrustum: boolean,
): void {
  if (node.subtreePointCount === 0 && node.voxelCount === 0) return;

  if (testFrustum) {
    const result = frustumTestAABB(ctx.planes, node.aabb);
    if (result === OUTSIDE) {
      ctx.frustumCulled++;
      return;
    }
    if (result === INSIDE) {
      testFrustum = false;
    }
  }

  const ss = screenSpaceSize(node.aabb, ctx.viewProj, ctx.vpW, ctx.vpH);
  if (ss < ctx.cachedMinScreenPx) {
    ctx.lodSkipped++;
    return;
  }

  const acx = (node.aabb.minX + node.aabb.maxX) * 0.5;
  const acy = (node.aabb.minY + node.aabb.maxY) * 0.5;
  const acz = (node.aabb.minZ + node.aabb.maxZ) * 0.5;
  const dxC = acx - ctx.camX;
  const dyC = acy - ctx.camY;
  const dzC = acz - ctx.camZ;
  const camDist2 = dxC * dxC + dyC * dyC + dzC * dzC;

  const wasRefined = ctx.refinedLastFrame[node.id] === 1;
  const fadeLow = wasRefined ? ctx.cachedFadeLowBase * HYSTERESIS_FACTOR : ctx.cachedFadeLowBase;
  const fadeHigh = wasRefined ? ctx.cachedFadeHighBase * HYSTERESIS_FACTOR : ctx.cachedFadeHighBase;

  if (node.isLeaf) {
    if (node.pointCount > 0) {
      const vn = ctx.acquireNode();
      vn.nodeId = node.id;
      vn.offset = node.pointOffset;
      vn.count = node.pointCount;
      vn.isVoxel = false;
      vn.depth = node.depth;
      vn.screenSize = ss;
      vn.density = 1.0;
      vn.qualityTier = 0;
      vn.qualityScale = 1.0;
      vn.fadeAlpha = 1.0;
      vn.camDist2 = camDist2;
      ctx.visibleNodes.push(vn);
      ctx.visiblePointCount += node.pointCount;
    }
    return;
  }

  if (ss < fadeLow) {
    if (node.voxelCount > 0) {
      const vn = ctx.acquireNode();
      vn.nodeId = node.id;
      vn.offset = node.voxelOffset;
      vn.count = node.voxelCount;
      vn.isVoxel = true;
      vn.depth = node.depth;
      vn.screenSize = ss;
      vn.density = 1.0;
      vn.qualityTier = 0;
      vn.qualityScale = 1.0;
      vn.fadeAlpha = 1.0;
      vn.camDist2 = camDist2;
      ctx.visibleNodes.push(vn);
      ctx.visiblePointCount += node.voxelCount;
      if (node.depth < ctx.voxelMinDepth) ctx.voxelMinDepth = node.depth;
    }
    ctx.lodSkipped++;
    return;
  }

  if (ss < fadeHigh && !node.isLeaf) {
    const childAlpha = smoothstep(fadeLow, fadeHigh, ss);
    const voxelAlpha = 1.0 - childAlpha;

    if (node.voxelCount > 0 && voxelAlpha > 0.05) {
      const vn = ctx.acquireNode();
      vn.nodeId = node.id;
      vn.offset = node.voxelOffset;
      vn.count = node.voxelCount;
      vn.isVoxel = true;
      vn.depth = node.depth;
      vn.screenSize = ss;
      vn.density = voxelAlpha;
      vn.qualityTier = 0;
      vn.qualityScale = 1.0;
      vn.fadeAlpha = voxelAlpha;
      vn.camDist2 = camDist2;
      ctx.visibleNodes.push(vn);
      ctx.visiblePointCount += Math.ceil(node.voxelCount * voxelAlpha);
      if (node.depth < ctx.voxelMinDepth) ctx.voxelMinDepth = node.depth;
    }

    ctx.refinedThisFrame[node.id] = 1;
    const pointsBefore = ctx.visiblePointCount;

    for (let i = 0; i < 8; i++) {
      const child = node.children[i];
      if (child) collectVisibleOctreeNode(child, ctx, testFrustum);
    }

    const nodesLen = ctx.visibleNodes.length;
    if (childAlpha < 0.95) {
      for (let j = nodesLen - 1; j >= 0; j--) {
        const vn = ctx.visibleNodes[j];
        if (vn && vn.fadeAlpha === 1.0 && !vn.isVoxel) {
          vn.fadeAlpha = childAlpha;
          vn.density = Math.max(MIN_DENSITY, vn.density * childAlpha);
        } else {
          break;
        }
      }
    }

    const childrenContributed = ctx.visiblePointCount > pointsBefore;
    if (!childrenContributed && node.voxelCount > 0 && voxelAlpha <= 0.05) {
      const vn = ctx.acquireNode();
      vn.nodeId = node.id;
      vn.offset = node.voxelOffset;
      vn.count = node.voxelCount;
      vn.isVoxel = true;
      vn.depth = node.depth;
      vn.screenSize = ss;
      vn.density = 1.0;
      vn.qualityTier = 0;
      vn.qualityScale = 1.0;
      vn.fadeAlpha = 1.0;
      vn.camDist2 = camDist2;
      ctx.visibleNodes.push(vn);
      ctx.visiblePointCount += node.voxelCount;
      if (node.depth < ctx.voxelMinDepth) ctx.voxelMinDepth = node.depth;
    }

    ctx.lodSkipped++;
    return;
  }

  ctx.refinedThisFrame[node.id] = 1;
  const pointsBefore = ctx.visiblePointCount;

  for (let i = 0; i < 8; i++) {
    const child = node.children[i];
    if (child) {
      collectVisibleOctreeNode(child, ctx, testFrustum);
    }
  }

  const childrenContributed = ctx.visiblePointCount > pointsBefore;
  if (!childrenContributed && node.voxelCount > 0) {
    const vn = ctx.acquireNode();
    vn.nodeId = node.id;
    vn.offset = node.voxelOffset;
    vn.count = node.voxelCount;
    vn.isVoxel = true;
    vn.depth = node.depth;
    vn.screenSize = ss;
    vn.density = 1.0;
    vn.qualityTier = 0;
    vn.qualityScale = 1.0;
    vn.fadeAlpha = 1.0;
    vn.camDist2 = camDist2;
    ctx.visibleNodes.push(vn);
    ctx.visiblePointCount += node.voxelCount;
    if (node.depth < ctx.voxelMinDepth) ctx.voxelMinDepth = node.depth;
  }
}
