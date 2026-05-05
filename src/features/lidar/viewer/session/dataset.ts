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

interface SceneTileProgressState {
  progress: number;
  detail: string;
}

export interface ViewerSceneData {
  pointCloud: PointCloudData;
  terrainMesh: TerrainCache;
  cacheWrites: CacheWriteTask[];
  tileFileLabel: string;
}

const DEFAULT_MULTI_TILE_POINT_CAP = 8_000_000;
const MIN_MULTI_TILE_POINT_CAP = 2_500_000;
const MAX_MULTI_TILE_POINT_CAP = 12_000_000;
const TILE_LOAD_COMPLETE_PROGRESS = 0.92;
const SCENE_LOAD_START_PCT = 4;
const SCENE_LOAD_END_PCT = 80;

export interface ViewerSceneLoadOptions {
  multiTilePointCap?: number;
  deviceMemoryGiB?: number;
  gpuInfo?: {
    vendor?: string;
    arch?: string;
    desc?: string;
  };
}

function getSceneLoadConcurrency(totalTiles: number): number {
  const hardwareThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const preferred = Math.max(2, Math.ceil(hardwareThreads / 4));
  return Math.max(1, Math.min(totalTiles, Math.min(4, preferred)));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker());
  await Promise.all(workers);
  return results;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundPointCap(value: number): number {
  return Math.max(MIN_MULTI_TILE_POINT_CAP, Math.round(value / 250_000) * 250_000);
}

function createSceneProgressReporter(
  tileCoords: TileCoord[],
  setStatus: ViewerStatusReporter,
): {
  updateTileProgress: (index: number, detail: string, progress: number) => void;
  updateSceneProgress: (detail: string, progress: number) => void;
} {
  const states: SceneTileProgressState[] = tileCoords.map((coord) => ({
    progress: 0,
    detail: `En attente ${coord.xKm}/${coord.yKm}`,
  }));
  let sceneFloor = 0;
  let sceneDetail = states[0]?.detail ?? 'Préparation de la scène';

  const emit = (overrideDetail?: string) => {
    const averageTileProgress = states.length > 0
      ? states.reduce((sum, state) => sum + state.progress, 0) / states.length
      : 1;
    const normalized = clamp(Math.max(sceneFloor, averageTileProgress), 0, 1);
    const detail = overrideDetail
      ?? (sceneFloor > averageTileProgress ? sceneDetail : undefined)
      ?? states
        .slice()
        .sort((left, right) => right.progress - left.progress)[0]?.detail
      ?? sceneDetail;
    const pct = SCENE_LOAD_START_PCT + normalized * (SCENE_LOAD_END_PCT - SCENE_LOAD_START_PCT);
    setStatus(detail, pct);
  };

  return {
    updateTileProgress(index: number, detail: string, progress: number) {
      const state = states[index];
      if (!state) return;
      state.detail = detail;
      state.progress = Math.max(state.progress, clamp(progress, 0, TILE_LOAD_COMPLETE_PROGRESS));
      emit();
    },
    updateSceneProgress(detail: string, progress: number) {
      sceneDetail = detail;
      sceneFloor = Math.max(sceneFloor, clamp(progress, 0, 1));
      emit(detail);
    },
  };
}

function resolveMultiTilePointCap(
  tileCount: number,
  options?: ViewerSceneLoadOptions,
): number {
  const explicitCap = options?.multiTilePointCap;
  if (Number.isFinite(explicitCap) && explicitCap && explicitCap > 0) {
    return Math.floor(explicitCap);
  }

  const rawMemoryGiB = options?.deviceMemoryGiB;
  const memoryGiB = Number.isFinite(rawMemoryGiB) && rawMemoryGiB
    ? clamp(rawMemoryGiB, 1, 16)
    : 4;

  const gpuInfo = options?.gpuInfo;
  const gpuHaystack = `${gpuInfo?.vendor ?? ''} ${gpuInfo?.arch ?? ''} ${gpuInfo?.desc ?? ''}`.toLowerCase();
  const isApple = gpuHaystack.includes('apple');
  const isDedicatedGpu = /nvidia|geforce|rtx|quadro|tesla|radeon\s+rx|radeon\s+pro|amd|arc\s|battlemage|alchemist/.test(gpuHaystack);
  const isIntegratedGpu = !isDedicatedGpu && /intel|iris|uhd|hd graphics|vega|apu|integrated/.test(gpuHaystack);

  let cap = memoryGiB <= 2
    ? 2_500_000
    : memoryGiB <= 4
      ? 4_500_000
      : memoryGiB < 8
        ? 6_500_000
        : DEFAULT_MULTI_TILE_POINT_CAP;

  // dGPU/Apple boosts help quality for small scenes, but they push memory
  // pressure too far on dense multi-tile scenes (worker allocates two large
  // Float32Array copies for the octree build). Scale the boost down with tile
  // count so 6-9 tile scenes don't trigger "Array buffer allocation failed"
  // in the octree worker on 8 GiB machines reporting deviceMemory=8.
  const boostScale = tileCount >= 8 ? 0.25 : tileCount >= 6 ? 0.5 : tileCount >= 4 ? 0.75 : 1;
  if (isDedicatedGpu) {
    cap += (memoryGiB >= 8 ? 2_000_000 : 1_000_000) * boostScale;
  } else if (isApple) {
    cap += (memoryGiB >= 8 ? 750_000 : 250_000) * boostScale;
  } else if (isIntegratedGpu) {
    cap -= memoryGiB <= 4 ? 750_000 : 250_000;
  }

  // Per-tile-count attenuation. The previous 0.94/0.97 factors were not
  // enough: the merged scene plus the worker's transient octree buffers
  // (positions+colors input, leafPositions+leafColors output, voxel arrays,
  // per-node JS index arrays) easily exceeded 400 MB on 7-tile scenes.
  if (tileCount >= 8) cap *= 0.7;
  else if (tileCount >= 6) cap *= 0.8;
  else if (tileCount >= 4) cap *= 0.9;

  return clamp(roundPointCap(cap), MIN_MULTI_TILE_POINT_CAP, MAX_MULTI_TILE_POINT_CAP);
}

function computeMergedPointTargetCount(
  tiles: LoadedViewerTile[],
  multiTilePointCap: number,
): { totalCount: number; targetCount: number } {
  const totalCount = tiles.reduce((sum, tile) => sum + tile.pointCloud.count, 0);
  if (tiles.length <= 1 || totalCount <= multiTilePointCap) {
    return { totalCount, targetCount: totalCount };
  }
  return { totalCount, targetCount: multiTilePointCap };
}

function computeTilePointQuotas(tiles: LoadedViewerTile[], targetCount: number, totalCount: number): Uint32Array {
  const quotas = new Uint32Array(tiles.length);
  if (targetCount >= totalCount) {
    for (let index = 0; index < tiles.length; index += 1) quotas[index] = tiles[index].pointCloud.count;
    return quotas;
  }

  const remainders: Array<{ index: number; remainder: number; count: number }> = [];
  let assigned = 0;

  for (let index = 0; index < tiles.length; index += 1) {
    const count = tiles[index].pointCloud.count;
    const rawQuota = (count / totalCount) * targetCount;
    const baseQuota = Math.min(count, Math.floor(rawQuota));
    quotas[index] = baseQuota;
    assigned += baseQuota;
    remainders.push({ index, remainder: rawQuota - baseQuota, count });
  }

  const nonEmptyTileCount = tiles.reduce((sum, tile) => sum + (tile.pointCloud.count > 0 ? 1 : 0), 0);
  if (targetCount >= nonEmptyTileCount) {
    for (let index = 0; index < tiles.length; index += 1) {
      if (tiles[index].pointCloud.count === 0 || quotas[index] > 0) continue;
      quotas[index] = 1;
      assigned += 1;
    }
  }

  if (assigned > targetCount) {
    const trimOrder = [...remainders].sort((left, right) => left.count - right.count || left.remainder - right.remainder);
    for (const entry of trimOrder) {
      if (assigned <= targetCount) break;
      if (quotas[entry.index] <= 1) continue;
      quotas[entry.index] -= 1;
      assigned -= 1;
    }
  }

  if (assigned < targetCount) {
    const growOrder = [...remainders].sort((left, right) => right.remainder - left.remainder || right.count - left.count);
    let growCursor = 0;
    while (assigned < targetCount && growOrder.length > 0) {
      const entry = growOrder[growCursor % growOrder.length];
      growCursor += 1;
      if (quotas[entry.index] >= tiles[entry.index].pointCloud.count) continue;
      quotas[entry.index] += 1;
      assigned += 1;
    }
  }

  return quotas;
}

function copyTilePointSample(
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
    positions[dstPos] = tile.pointCloud.positions[srcPos];
    positions[dstPos + 1] = tile.pointCloud.positions[srcPos + 1];
    positions[dstPos + 2] = tile.pointCloud.positions[srcPos + 2];
    colors[dstPos] = tile.pointCloud.colors[srcPos];
    colors[dstPos + 1] = tile.pointCloud.colors[srcPos + 1];
    colors[dstPos + 2] = tile.pointCloud.colors[srcPos + 2];
    classifications[pointOffset + sampleIndex] = tile.pointCloud.classifications[srcIndex];
  }

  return pointOffset + quota;
}

function mergePointClouds(tiles: LoadedViewerTile[], multiTilePointCap: number): PointCloudData {
  if (tiles.length === 1) return tiles[0].pointCloud;

  const { totalCount, targetCount } = computeMergedPointTargetCount(tiles, multiTilePointCap);
  const positions = new Float32Array(targetCount * 3);
  const colors = new Uint8Array(targetCount * 3);
  const classifications = new Uint8Array(targetCount);
  const bounds = unionBounds(tiles.map((tile) => tile.pointCloud.bounds));
  const quotas = computeTilePointQuotas(tiles, targetCount, totalCount);

  let pointOffset = 0;
  for (let index = 0; index < tiles.length; index += 1) {
    pointOffset = copyTilePointSample(
      tiles[index],
      quotas[index],
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
        heightGrid[dstStart + column] = terrain.heightGrid[row * terrain.gridWidth + column] + deltaHeight;
      }
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
  reportProgress: (detail: string, progress: number) => void,
  index: number,
  total: number,
): Promise<LoadedViewerTile> {
  const { fileName, legacyFileName } = buildTileFileCandidates(coord);
  const tileTag = `${coord.xKm}/${coord.yKm}`;
  let shouldSaveColorizedCache = false;
  let shouldSaveTerrainCache = false;

  reportProgress(`Cache colorise ${index}/${total} : ${tileTag}`, 0.06);
  let pointCloud = await loadColorizedData(fileName);
  if (!pointCloud) {
    reportProgress(`Chargement LAZ ${index}/${total} : ${tileTag}`, 0.12);
    const buffer = await loadTileFromOPFS([fileName, legacyFileName]);
    pointCloud = await processPointCloudInWorker(buffer, (message, pct) => {
      const normalized = 0.18 + Math.max(0, Math.min(1, (pct ?? 0) / 100)) * 0.54;
      reportProgress(`${tileTag} · ${message}`, normalized);
    });
    shouldSaveColorizedCache = true;
  } else {
    reportProgress(`Cache LiDAR prêt ${index}/${total} : ${tileTag}`, 0.78);
  }

  reportProgress(`Terrain ${index}/${total} : ${tileTag}`, 0.82);
  let terrainMesh = await loadTerrainData(fileName);
  if (!terrainMesh) {
    terrainMesh = await generateHeightmap(pointCloud);
    shouldSaveTerrainCache = true;
  }

  reportProgress(`Dalle prête ${index}/${total} : ${tileTag}`, TILE_LOAD_COMPLETE_PROGRESS);

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
  options?: ViewerSceneLoadOptions,
): Promise<ViewerSceneData> {
  const uniqueTiles = tileCoords.filter((coord, index, all) => {
    const key = `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}`;
    return all.findIndex((candidate) => `${candidate.xKm}_${candidate.yKm}_${candidate.projection}_${candidate.altRef}` === key) === index;
  });

  const loadConcurrency = getSceneLoadConcurrency(uniqueTiles.length);
  const progress = createSceneProgressReporter(uniqueTiles, setStatus);
  progress.updateSceneProgress(
    `Preparation scene ${uniqueTiles.length} tuiles · ${loadConcurrency} taches en parallele`,
    0,
  );

  const loadedTiles = await mapWithConcurrency(
    uniqueTiles,
    loadConcurrency,
    (coord, index) => loadViewerTile(
      coord,
      (detail, normalizedProgress) => progress.updateTileProgress(index, detail, normalizedProgress),
      index + 1,
      uniqueTiles.length,
    ),
  );

  const multiTilePointCap = resolveMultiTilePointCap(uniqueTiles.length, options);
  const { totalCount, targetCount } = computeMergedPointTargetCount(loadedTiles, multiTilePointCap);
  if (targetCount < totalCount) {
    progress.updateSceneProgress(
      `Scene dense: cap adaptatif ${targetCount.toLocaleString()} / ${totalCount.toLocaleString()} pts...`,
      0.95,
    );
    console.warn(
      `[Viewer] Adaptive multi-tile point cap: ${targetCount.toLocaleString()} / ${totalCount.toLocaleString()} ` +
      `(tiles=${uniqueTiles.length}, RAM=${options?.deviceMemoryGiB ?? 'n/a'} GiB, GPU=${options?.gpuInfo?.vendor ?? 'unknown'} ${options?.gpuInfo?.arch ?? ''})`,
    );
  }

  const pointCloud = mergePointClouds(loadedTiles, multiTilePointCap);
  progress.updateSceneProgress(`Assemblage final ${uniqueTiles.length} tuiles...`, 0.97);
  let terrainMesh = mergeTerrainMeshes(loadedTiles, pointCloud);
  if (!terrainMesh) {
    progress.updateSceneProgress('Fusion terrain impossible, regeneration scene...', 0.985);
    terrainMesh = await generateHeightmap(pointCloud);
  }
  progress.updateSceneProgress(`Scene prête ${uniqueTiles.length} tuiles`, 1);

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