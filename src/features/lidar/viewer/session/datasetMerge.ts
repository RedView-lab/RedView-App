import type { PointCloudBounds, TileCoord } from '../../types';
import type { TerrainCache } from '../../lib/storage';
import type { TerrainPart } from '../renderer/terrainLod';

/**
 * Scene terrain: the tiles' meshes concatenated, without an index list (the
 * renderer draws each tile grid per chunk, see TerrainLod), and the merged
 * height grid.
 */
export interface SceneTerrain extends TerrainCache {
  /** Vertex grid of each tile inside `vertices`. */
  parts: TerrainPart[];
}

export interface LoadedViewerTile {
  coord: TileCoord;
  /** Absolute CRS bounds of the tile's points. */
  bounds: PointCloudBounds;
  terrainMesh: TerrainCache;
}

export function unionBounds(boundsList: PointCloudBounds[]): PointCloudBounds {
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

/**
 * Merges the tiles' height grids (rows south→north, heights relative to each
 * tile's centre altitude) into one grid over `mergedBounds`, relative to the
 * merged centre altitude. Each merged cell is bilinearly resampled from the
 * tile covering it, so tiles whose grid steps differ slightly still merge.
 */
export function mergeHeightGrid(tiles: LoadedViewerTile[], mergedBounds: PointCloudBounds): {
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
} {
  if (tiles.length === 1) {
    return {
      heightGrid: tiles[0]!.terrainMesh.heightGrid,
      gridWidth: tiles[0]!.terrainMesh.gridWidth,
      gridHeight: tiles[0]!.terrainMesh.gridHeight,
    };
  }

  const steps = tiles.map((tile) => ({
    x: (tile.bounds.maxX - tile.bounds.minX) / Math.max(1, tile.terrainMesh.gridWidth - 1),
    y: (tile.bounds.maxY - tile.bounds.minY) / Math.max(1, tile.terrainMesh.gridHeight - 1),
  }));
  const step = Math.max(1e-3, Math.min(...steps.map((s) => Math.min(s.x, s.y))));
  const mergedCenterZ = (mergedBounds.minZ + mergedBounds.maxZ) / 2;
  const rangeX = mergedBounds.maxX - mergedBounds.minX;
  const rangeY = mergedBounds.maxY - mergedBounds.minY;
  const gridWidth = Math.max(2, Math.round(rangeX / step) + 1);
  const gridHeight = Math.max(2, Math.round(rangeY / step) + 1);
  // Consumers place node i at min + i·range/(n − 1): sample at that spacing,
  // not at `step`, which the rounding above leaves up to half a step off.
  const stepX = rangeX / (gridWidth - 1);
  const stepY = rangeY / (gridHeight - 1);
  const heightGrid = new Float32Array(gridWidth * gridHeight).fill(Number.NaN);

  tiles.forEach((tile, tileIndex) => {
    const { bounds, terrainMesh } = tile;
    const { heightGrid: src, gridWidth: w, gridHeight: h } = terrainMesh;
    const tileStep = steps[tileIndex]!;
    const deltaHeight = (bounds.minZ + bounds.maxZ) / 2 - mergedCenterZ;
    const firstCol = Math.max(0, Math.ceil((bounds.minX - mergedBounds.minX) / stepX - 1e-6));
    const lastCol = Math.min(gridWidth - 1, Math.floor((bounds.maxX - mergedBounds.minX) / stepX + 1e-6));
    const firstRow = Math.max(0, Math.ceil((bounds.minY - mergedBounds.minY) / stepY - 1e-6));
    const lastRow = Math.min(gridHeight - 1, Math.floor((bounds.maxY - mergedBounds.minY) / stepY + 1e-6));

    for (let row = firstRow; row <= lastRow; row++) {
      const v = Math.min(h - 1, Math.max(0, (mergedBounds.minY + row * stepY - bounds.minY) / tileStep.y));
      const v0 = Math.floor(v);
      const v1 = Math.min(h - 1, v0 + 1);
      const fv = v - v0;
      for (let col = firstCol; col <= lastCol; col++) {
        const u = Math.min(w - 1, Math.max(0, (mergedBounds.minX + col * stepX - bounds.minX) / tileStep.x));
        const u0 = Math.floor(u);
        const u1 = Math.min(w - 1, u0 + 1);
        const fu = u - u0;
        const top = src[v0 * w + u0]! * (1 - fu) + src[v0 * w + u1]! * fu;
        const bottom = src[v1 * w + u0]! * (1 - fu) + src[v1 * w + u1]! * fu;
        heightGrid[row * gridWidth + col] = top * (1 - fv) + bottom * fv + deltaHeight;
      }
    }
  });

  fillMissingHeightSamples(heightGrid, gridWidth, gridHeight);
  return { heightGrid, gridWidth, gridHeight };
}

/** Grid of a tile mesh (vertices row-major, `gridWidth` per row). */
function tilePart(terrain: TerrainCache, vertexOffset: number): TerrainPart {
  return { vertexOffset, gridWidth: terrain.gridWidth, gridHeight: terrain.gridHeight };
}

/** Concatenates the tiles' terrain meshes in the merged (centred) frame. */
export function mergeTerrainMeshes(tiles: LoadedViewerTile[], mergedBounds: PointCloudBounds): SceneTerrain {
  if (tiles.length === 1) {
    const terrain = tiles[0]!.terrainMesh;
    return { ...terrain, parts: [tilePart(terrain, 0)] };
  }

  const totalVertexCount = tiles.reduce((sum, tile) => sum + tile.terrainMesh.vertexCount, 0);
  const vertices = new Float32Array(totalVertexCount * 6);
  const colors = new Uint8Array(totalVertexCount * 4);
  const parts: TerrainPart[] = [];
  const mergedCenterX = (mergedBounds.minX + mergedBounds.maxX) / 2;
  const mergedCenterY = (mergedBounds.minY + mergedBounds.maxY) / 2;
  const mergedCenterZ = (mergedBounds.minZ + mergedBounds.maxZ) / 2;

  let vertexOffset = 0;
  for (const tile of tiles) {
    const bounds = tile.bounds;
    const deltaX = (bounds.minX + bounds.maxX) / 2 - mergedCenterX;
    const deltaY = (bounds.minY + bounds.maxY) / 2 - mergedCenterY;
    const deltaZ = (bounds.minZ + bounds.maxZ) / 2 - mergedCenterZ;
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
    parts.push(tilePart(terrain, vertexOffset));
    vertexOffset += terrain.vertexCount;
  }

  const mergedGrid = mergeHeightGrid(tiles, mergedBounds);
  return {
    vertices,
    colors,
    indices: new Uint32Array(0),
    vertexCount: totalVertexCount,
    indexCount: 0,
    parts,
    heightGrid: mergedGrid.heightGrid,
    gridWidth: mergedGrid.gridWidth,
    gridHeight: mergedGrid.gridHeight,
  };
}
