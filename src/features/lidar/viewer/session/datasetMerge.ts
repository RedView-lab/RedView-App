import type { PointCloudData, TileCoord } from '../../types';
import type { TerrainCache } from '../../lib/storage';

export interface LoadedViewerTile {
  coord: TileCoord;
  fileName: string;
  pointCloud: PointCloudData;
  terrainMesh: TerrainCache;
  shouldSaveColorizedCache: boolean;
  shouldSaveTerrainCache: boolean;
}

export function unionBounds(boundsList: PointCloudData['bounds'][]): PointCloudData['bounds'] {
  const first = boundsList[0];
  if (!first) {
    return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  }
  return boundsList.reduce((acc, bounds) => ({
    minX: Math.min(acc.minX, bounds.minX),
    minY: Math.min(acc.minY, bounds.minY),
    minZ: Math.min(acc.minZ, bounds.minZ),
    maxX: Math.max(acc.maxX, bounds.maxX),
    maxY: Math.max(acc.maxY, bounds.maxY),
    maxZ: Math.max(acc.maxZ, bounds.maxZ),
  }), first);
}

export function computeMergedPointTargetCount(
  tiles: LoadedViewerTile[],
  multiTilePointCap: number,
): { totalCount: number; targetCount: number } {
  const totalCount = tiles.reduce((sum, tile) => sum + tile.pointCloud.count, 0);
  if (tiles.length <= 1 || totalCount <= multiTilePointCap) {
    return { totalCount, targetCount: totalCount };
  }
  return { totalCount, targetCount: multiTilePointCap };
}

export function computeTilePointQuotas(tiles: LoadedViewerTile[], targetCount: number, totalCount: number): Uint32Array {
  const quotas = new Uint32Array(tiles.length);
  if (targetCount >= totalCount) {
    for (let index = 0; index < tiles.length; index += 1) quotas[index] = tiles[index]!.pointCloud.count;
    return quotas;
  }

  const remainders: Array<{ index: number; remainder: number; count: number }> = [];
  let assigned = 0;

  for (let index = 0; index < tiles.length; index += 1) {
    const count = tiles[index]!.pointCloud.count;
    const rawQuota = (count / totalCount) * targetCount;
    const baseQuota = Math.min(count, Math.floor(rawQuota));
    quotas[index] = baseQuota;
    assigned += baseQuota;
    remainders.push({ index, remainder: rawQuota - baseQuota, count });
  }

  const nonEmptyTileCount = tiles.reduce((sum, tile) => sum + (tile.pointCloud.count > 0 ? 1 : 0), 0);
  if (targetCount >= nonEmptyTileCount) {
    for (let index = 0; index < tiles.length; index += 1) {
      if (tiles[index]!.pointCloud.count === 0 || quotas[index]! > 0) continue;
      quotas[index] = 1;
      assigned += 1;
    }
  }

  if (assigned > targetCount) {
    const trimOrder = [...remainders].sort((left, right) => left.count - right.count || left.remainder - right.remainder);
    for (const entry of trimOrder) {
      if (assigned <= targetCount) break;
      if (quotas[entry.index]! <= 1) continue;
      quotas[entry.index] -= 1;
      assigned -= 1;
    }
  }

  if (assigned < targetCount) {
    const growOrder = [...remainders].sort((left, right) => right.remainder - left.remainder || right.count - left.count);
    let growCursor = 0;
    while (assigned < targetCount && growOrder.length > 0) {
      const entry = growOrder[growCursor % growOrder.length]!;
      growCursor += 1;
      if (quotas[entry.index]! >= tiles[entry.index]!.pointCloud.count) continue;
      quotas[entry.index] += 1;
      assigned += 1;
    }
  }

  return quotas;
}

export function copyTilePointSample(
  tile: LoadedViewerTile,
  quota: number,
  positions: Float32Array,
  colors: Uint8Array,
  classifications: Uint8Array,
  pointOffset: number,
): number {
  if (quota <= 0 || tile.pointCloud.count <= 0) return pointOffset;

  if (quota >= tile.pointCloud.count) {
    positions.set(tile.pointCloud.positions, pointOffset * 3);
    colors.set(tile.pointCloud.colors, pointOffset * 3);
    classifications.set(tile.pointCloud.classifications, pointOffset);
    return pointOffset + tile.pointCloud.count;
  }

  const sampleStep = tile.pointCloud.count / quota;
  for (let sampleIndex = 0; sampleIndex < quota; sampleIndex += 1) {
    const srcIndex = Math.min(tile.pointCloud.count - 1, Math.floor((sampleIndex + 0.5) * sampleStep));
    const srcPos = srcIndex * 3;
    const dstPos = (pointOffset + sampleIndex) * 3;
    positions[dstPos] = tile.pointCloud.positions[srcPos]!;
    positions[dstPos + 1] = tile.pointCloud.positions[srcPos + 1]!;
    positions[dstPos + 2] = tile.pointCloud.positions[srcPos + 2]!;
    colors[dstPos] = tile.pointCloud.colors[srcPos]!;
    colors[dstPos + 1] = tile.pointCloud.colors[srcPos + 1]!;
    colors[dstPos + 2] = tile.pointCloud.colors[srcPos + 2]!;
    classifications[pointOffset + sampleIndex] = tile.pointCloud.classifications[srcIndex]!;
  }

  return pointOffset + quota;
}

export function mergePointClouds(tiles: LoadedViewerTile[], multiTilePointCap: number): PointCloudData {
  if (tiles.length === 1) return tiles[0]!.pointCloud;

  const { totalCount, targetCount } = computeMergedPointTargetCount(tiles, multiTilePointCap);
  const positions = new Float32Array(targetCount * 3);
  const colors = new Uint8Array(targetCount * 3);
  const classifications = new Uint8Array(targetCount);
  const bounds = unionBounds(tiles.map((tile) => tile.pointCloud.bounds));
  const quotas = computeTilePointQuotas(tiles, targetCount, totalCount);

  let pointOffset = 0;
  for (let index = 0; index < tiles.length; index += 1) {
    pointOffset = copyTilePointSample(
      tiles[index]!,
      quotas[index]!,
      positions,
      colors,
      classifications,
      pointOffset,
    );
  }

  const mergedCount = pointOffset;
  if (mergedCount !== targetCount) {
    throw new Error(`Merged point cloud quota mismatch: expected ${targetCount}, got ${mergedCount}`);
  }

  if (targetCount < totalCount) {
    console.warn(
      `[Viewer] Multi-tile scene sampled from ${totalCount.toLocaleString()} to ${targetCount.toLocaleString()} points before octree build.`,
    );
  }

  return {
    positions,
    colors,
    classifications,
    count: targetCount,
    bounds,
    crs: tiles[0]!.pointCloud.crs,
  };
}

export function fillMissingHeightSamples(heightGrid: Float32Array, gridWidth: number, gridHeight: number): void {
  const queue: number[] = [];

  for (let index = 0; index < heightGrid.length; index += 1) {
    if (!Number.isNaN(heightGrid[index])) queue.push(index);
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const index = queue[cursor++]!;
    const value = heightGrid[index]!;
    const x = index % gridWidth;
    const y = Math.floor(index / gridWidth);

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < gridWidth - 1 ? index + 1 : -1,
      y > 0 ? index - gridWidth : -1,
      y < gridHeight - 1 ? index + gridWidth : -1,
    ];

    for (const neighbor of neighbors) {
      if (neighbor < 0 || !Number.isNaN(heightGrid[neighbor])) continue;
      heightGrid[neighbor] = value;
      queue.push(neighbor);
    }
  }
}

export function mergeHeightGrid(tiles: LoadedViewerTile[], mergedPointCloud: PointCloudData): {
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
} | null {
  if (tiles.length === 1) {
    return {
      heightGrid: tiles[0]!.terrainMesh.heightGrid,
      gridWidth: tiles[0]!.terrainMesh.gridWidth,
      gridHeight: tiles[0]!.terrainMesh.gridHeight,
    };
  }

  const firstTile = tiles[0]!;
  const firstBounds = firstTile.pointCloud.bounds;
  const firstTerrain = firstTile.terrainMesh;
  const stepX = (firstBounds.maxX - firstBounds.minX) / Math.max(1, firstTerrain.gridWidth - 1);
  const stepY = (firstBounds.maxY - firstBounds.minY) / Math.max(1, firstTerrain.gridHeight - 1);

  for (const tile of tiles.slice(1)) {
    const bounds = tile.pointCloud.bounds;
    const terrain = tile.terrainMesh;
    const candidateStepX = (bounds.maxX - bounds.minX) / Math.max(1, terrain.gridWidth - 1);
    const candidateStepY = (bounds.maxY - bounds.minY) / Math.max(1, terrain.gridHeight - 1);
    if (Math.abs(candidateStepX - stepX) > 0.001 || Math.abs(candidateStepY - stepY) > 0.001) {
      return null;
    }
  }

  const mergedBounds = mergedPointCloud.bounds;
  const mergedCenterZ = (mergedBounds.minZ + mergedBounds.maxZ) / 2;
  const gridWidth = Math.round((mergedBounds.maxX - mergedBounds.minX) / stepX) + 1;
  const gridHeight = Math.round((mergedBounds.maxY - mergedBounds.minY) / stepY) + 1;
  const heightGrid = new Float32Array(gridWidth * gridHeight).fill(Number.NaN);

  for (const tile of tiles) {
    const bounds = tile.pointCloud.bounds;
    const terrain = tile.terrainMesh;
    const tileCenterZ = (bounds.minZ + bounds.maxZ) / 2;
    const deltaHeight = tileCenterZ - mergedCenterZ;
    const offsetX = Math.round((bounds.minX - mergedBounds.minX) / stepX);
    const offsetY = Math.round((bounds.minY - mergedBounds.minY) / stepY);

    for (let row = 0; row < terrain.gridHeight; row += 1) {
      const dstStart = (offsetY + row) * gridWidth + offsetX;
      for (let column = 0; column < terrain.gridWidth; column += 1) {
        heightGrid[dstStart + column] = terrain.heightGrid[row * terrain.gridWidth + column]! + deltaHeight;
      }
    }
  }

  fillMissingHeightSamples(heightGrid, gridWidth, gridHeight);
  return { heightGrid, gridWidth, gridHeight };
}

export function mergeTerrainMeshes(tiles: LoadedViewerTile[], mergedPointCloud: PointCloudData): TerrainCache | null {
  if (tiles.length === 1) return tiles[0]!.terrainMesh;

  const totalVertexCount = tiles.reduce((sum, tile) => sum + tile.terrainMesh.vertexCount, 0);
  const totalIndexCount = tiles.reduce((sum, tile) => sum + tile.terrainMesh.indexCount, 0);
  const vertices = new Float32Array(totalVertexCount * 6);
  const colors = new Uint8Array(totalVertexCount * 4);
  const indices = new Uint32Array(totalIndexCount);
  const mergedBounds = mergedPointCloud.bounds;
  const mergedCenterX = (mergedBounds.minX + mergedBounds.maxX) / 2;
  const mergedCenterY = (mergedBounds.minY + mergedBounds.maxY) / 2;
  const mergedCenterZ = (mergedBounds.minZ + mergedBounds.maxZ) / 2;

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const tile of tiles) {
    const bounds = tile.pointCloud.bounds;
    const tileCenterX = (bounds.minX + bounds.maxX) / 2;
    const tileCenterY = (bounds.minY + bounds.maxY) / 2;
    const tileCenterZ = (bounds.minZ + bounds.maxZ) / 2;
    const deltaX = tileCenterX - mergedCenterX;
    const deltaY = tileCenterY - mergedCenterY;
    const deltaZ = tileCenterZ - mergedCenterZ;
    const terrain = tile.terrainMesh;

    for (let i = 0; i < terrain.vertexCount; i += 1) {
      const src = i * 6;
      const dst = (vertexOffset + i) * 6;
      vertices[dst] = terrain.vertices[src]! + deltaX;
      vertices[dst + 1] = terrain.vertices[src + 1]! + deltaZ;
      vertices[dst + 2] = terrain.vertices[src + 2]! - deltaY;
      vertices[dst + 3] = terrain.vertices[src + 3]!;
      vertices[dst + 4] = terrain.vertices[src + 4]!;
      vertices[dst + 5] = terrain.vertices[src + 5]!;
    }

    colors.set(terrain.colors.subarray(0, terrain.vertexCount * 4), vertexOffset * 4);

    for (let i = 0; i < terrain.indexCount; i += 1) {
      indices[indexOffset + i] = terrain.indices[i]! + vertexOffset;
    }

    vertexOffset += terrain.vertexCount;
    indexOffset += terrain.indexCount;
  }

  const mergedGrid = mergeHeightGrid(tiles, mergedPointCloud);
  if (!mergedGrid) return null;

  return {
    vertices,
    colors,
    indices,
    vertexCount: totalVertexCount,
    indexCount: totalIndexCount,
    heightGrid: mergedGrid.heightGrid,
    gridWidth: mergedGrid.gridWidth,
    gridHeight: mergedGrid.gridHeight,
  };
}
