import type { PointCloudData, TileCoord } from '../../types';
import {
  loadColorizedData,
  loadTerrainData,
  saveColorizedData,
  saveTerrainData,
  type TerrainCache,
} from '../../lib/storage';
import { buildTileFileName } from '../../lib/coordConvert';
import { generateHeightmap } from '../heightmap';
import { loadTileFromOPFS, processPointCloudInWorker, type ViewerStatusReporter } from '../runtime';

interface LoadedViewerTile {
  coord: TileCoord;
  fileName: string;
  pointCloud: PointCloudData;
  terrainMesh: TerrainCache;
  shouldSaveColorizedCache: boolean;
  shouldSaveTerrainCache: boolean;
}

interface CacheWriteTask {
  label: string;
  task: () => Promise<void>;
}

export interface ViewerSceneData {
  pointCloud: PointCloudData;
  terrainMesh: TerrainCache;
  cacheWrites: CacheWriteTask[];
  tileFileLabel: string;
}

function buildTileFileCandidates(coord: TileCoord): { fileName: string; legacyFileName: string } {
  return {
    fileName: `${buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef)}.copc.laz`,
    legacyFileName: `${buildTileFileName(coord.xKm, coord.yKm - 1, coord.projection, coord.altRef)}.copc.laz`,
  };
}

function unionBounds(boundsList: PointCloudData['bounds'][]): PointCloudData['bounds'] {
  return boundsList.reduce((acc, bounds) => ({
    minX: Math.min(acc.minX, bounds.minX),
    minY: Math.min(acc.minY, bounds.minY),
    minZ: Math.min(acc.minZ, bounds.minZ),
    maxX: Math.max(acc.maxX, bounds.maxX),
    maxY: Math.max(acc.maxY, bounds.maxY),
    maxZ: Math.max(acc.maxZ, bounds.maxZ),
  }));
}

function mergePointClouds(tiles: LoadedViewerTile[]): PointCloudData {
  if (tiles.length === 1) return tiles[0].pointCloud;

  const totalCount = tiles.reduce((sum, tile) => sum + tile.pointCloud.count, 0);
  const positions = new Float32Array(totalCount * 3);
  const colors = new Uint8Array(totalCount * 3);
  const classifications = new Uint8Array(totalCount);
  const bounds = unionBounds(tiles.map((tile) => tile.pointCloud.bounds));

  let pointOffset = 0;
  for (const tile of tiles) {
    positions.set(tile.pointCloud.positions, pointOffset * 3);
    colors.set(tile.pointCloud.colors, pointOffset * 3);
    classifications.set(tile.pointCloud.classifications, pointOffset);
    pointOffset += tile.pointCloud.count;
  }

  return {
    positions,
    colors,
    classifications,
    count: totalCount,
    bounds,
    crs: tiles[0].pointCloud.crs,
  };
}

function fillMissingHeightSamples(heightGrid: Float32Array, gridWidth: number, gridHeight: number): void {
  const queue: number[] = [];

  for (let index = 0; index < heightGrid.length; index += 1) {
    if (!Number.isNaN(heightGrid[index])) queue.push(index);
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const index = queue[cursor++];
    const value = heightGrid[index];
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

function mergeHeightGrid(tiles: LoadedViewerTile[], mergedPointCloud: PointCloudData): {
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
} | null {
  if (tiles.length === 1) {
    return {
      heightGrid: tiles[0].terrainMesh.heightGrid,
      gridWidth: tiles[0].terrainMesh.gridWidth,
      gridHeight: tiles[0].terrainMesh.gridHeight,
    };
  }

  const firstTile = tiles[0];
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
  const gridWidth = Math.round((mergedBounds.maxX - mergedBounds.minX) / stepX) + 1;
  const gridHeight = Math.round((mergedBounds.maxY - mergedBounds.minY) / stepY) + 1;
  const heightGrid = new Float32Array(gridWidth * gridHeight).fill(Number.NaN);

  for (const tile of tiles) {
    const bounds = tile.pointCloud.bounds;
    const terrain = tile.terrainMesh;
    const offsetX = Math.round((bounds.minX - mergedBounds.minX) / stepX);
    const offsetY = Math.round((bounds.minY - mergedBounds.minY) / stepY);

    for (let row = 0; row < terrain.gridHeight; row += 1) {
      const srcStart = row * terrain.gridWidth;
      const dstStart = (offsetY + row) * gridWidth + offsetX;
      heightGrid.set(terrain.heightGrid.subarray(srcStart, srcStart + terrain.gridWidth), dstStart);
    }
  }

  fillMissingHeightSamples(heightGrid, gridWidth, gridHeight);
  return { heightGrid, gridWidth, gridHeight };
}

function mergeTerrainMeshes(tiles: LoadedViewerTile[], mergedPointCloud: PointCloudData): TerrainCache | null {
  if (tiles.length === 1) return tiles[0].terrainMesh;

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
    const deltaY = tileCenterZ - mergedCenterZ;
    const deltaZ = mergedCenterY - tileCenterY;

    for (let index = 0; index < tile.terrainMesh.vertexCount; index += 1) {
      const srcBase = index * 6;
      const dstBase = (vertexOffset + index) * 6;
      vertices[dstBase] = tile.terrainMesh.vertices[srcBase] + deltaX;
      vertices[dstBase + 1] = tile.terrainMesh.vertices[srcBase + 1] + deltaY;
      vertices[dstBase + 2] = tile.terrainMesh.vertices[srcBase + 2] + deltaZ;
      vertices[dstBase + 3] = tile.terrainMesh.vertices[srcBase + 3];
      vertices[dstBase + 4] = tile.terrainMesh.vertices[srcBase + 4];
      vertices[dstBase + 5] = tile.terrainMesh.vertices[srcBase + 5];
    }

    colors.set(tile.terrainMesh.colors, vertexOffset * 4);
    for (let index = 0; index < tile.terrainMesh.indexCount; index += 1) {
      indices[indexOffset + index] = tile.terrainMesh.indices[index] + vertexOffset;
    }

    vertexOffset += tile.terrainMesh.vertexCount;
    indexOffset += tile.terrainMesh.indexCount;
  }

  const mergedHeight = mergeHeightGrid(tiles, mergedPointCloud);
  if (!mergedHeight) return null;

  return {
    vertices,
    colors,
    indices,
    vertexCount: totalVertexCount,
    indexCount: totalIndexCount,
    heightGrid: mergedHeight.heightGrid,
    gridWidth: mergedHeight.gridWidth,
    gridHeight: mergedHeight.gridHeight,
  };
}

async function loadViewerTile(
  coord: TileCoord,
  setStatus: ViewerStatusReporter,
  index: number,
  total: number,
): Promise<LoadedViewerTile> {
  const { fileName, legacyFileName } = buildTileFileCandidates(coord);
  const tileTag = `${coord.xKm}/${coord.yKm}`;
  let shouldSaveColorizedCache = false;
  let shouldSaveTerrainCache = false;

  setStatus(`Cache colorise ${index}/${total} : ${tileTag}`, 5 + index * 10);
  let pointCloud = await loadColorizedData(fileName);
  if (!pointCloud) {
    setStatus(`Chargement LAZ ${tileTag}`, 10 + index * 15);
    const buffer = await loadTileFromOPFS([fileName, legacyFileName]);
    pointCloud = await processPointCloudInWorker(buffer, (message, pct) => {
      setStatus(`${tileTag} · ${message}`, 15 + (pct ?? 0) * 0.55);
    });
    shouldSaveColorizedCache = true;
  }

  setStatus(`Terrain ${index}/${total} : ${tileTag}`, 60 + index * 10);
  let terrainMesh = await loadTerrainData(fileName);
  if (!terrainMesh) {
    terrainMesh = await generateHeightmap(pointCloud);
    shouldSaveTerrainCache = true;
  }

  return {
    coord,
    fileName,
    pointCloud,
    terrainMesh,
    shouldSaveColorizedCache,
    shouldSaveTerrainCache,
  };
}

export async function loadViewerScene(
  tileCoords: TileCoord[],
  setStatus: ViewerStatusReporter,
): Promise<ViewerSceneData> {
  const uniqueTiles = tileCoords.filter((coord, index, all) => {
    const key = `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}`;
    return all.findIndex((candidate) => `${candidate.xKm}_${candidate.yKm}_${candidate.projection}_${candidate.altRef}` === key) === index;
  });

  const loadedTiles: LoadedViewerTile[] = [];
  for (let index = 0; index < uniqueTiles.length; index += 1) {
    loadedTiles.push(await loadViewerTile(uniqueTiles[index], setStatus, index + 1, uniqueTiles.length));
  }

  const pointCloud = mergePointClouds(loadedTiles);
  let terrainMesh = mergeTerrainMeshes(loadedTiles, pointCloud);
  if (!terrainMesh) {
    setStatus('Fusion terrain impossible, regeneration scene...', 76);
    terrainMesh = await generateHeightmap(pointCloud);
  }

  const cacheWrites: CacheWriteTask[] = [];
  for (const tile of loadedTiles) {
    if (tile.shouldSaveColorizedCache) {
      cacheWrites.push({
        label: `colorized:${tile.coord.xKm}/${tile.coord.yKm}`,
        task: () => saveColorizedData(tile.fileName, tile.pointCloud),
      });
    }
    if (tile.shouldSaveTerrainCache) {
      cacheWrites.push({
        label: `terrain:${tile.coord.xKm}/${tile.coord.yKm}`,
        task: () => saveTerrainData(tile.fileName, tile.terrainMesh),
      });
    }
  }

  return {
    pointCloud,
    terrainMesh,
    cacheWrites,
    tileFileLabel: loadedTiles.map((tile) => tile.fileName).join(' + '),
  };
}