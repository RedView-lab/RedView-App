import type { PointCloudData, TileCoord } from '../../types';
import {
  loadColorizedData,
  loadTerrainData,
  saveColorizedData,
  saveTerrainData,
  type TerrainCache,
} from '../../lib/storage';
import { generateHeightmap } from '../heightmap';
import { loadTileFromOPFS, processPointCloudInWorker, type ViewerStatusReporter } from '../runtime';
import {
  buildTileFileCandidates,
  createSceneProgressReporter,
  getSceneLoadConcurrency,
  mapWithConcurrency,
  resolveMultiTilePointCap,
  type ViewerSceneLoadOptions,
} from './datasetPointCap';
import {
  mergePointClouds,
  mergeTerrainMeshes,
  type LoadedViewerTile,
} from './datasetMerge';

export type { ViewerSceneLoadOptions } from './datasetPointCap';

export interface CacheWriteTask {
  label: string;
  task: () => Promise<void>;
}

export interface ViewerSceneData {
  pointCloud: PointCloudData;
  terrainMesh: TerrainCache;
  cacheWrites: CacheWriteTask[];
  tileFileLabel: string;
}

async function loadViewerTile(
  coord: TileCoord,
  onProgress: (detail: string, progress: number) => void,
): Promise<LoadedViewerTile> {
  const { fileName, legacyFileName } = buildTileFileCandidates(coord);
  let resolvedFileName = fileName;
  let fileBuffer: ArrayBuffer;

  onProgress(`Lecture OPFS ${coord.xKm}/${coord.yKm}`, 0.05);
  try {
    fileBuffer = await loadTileFromOPFS([fileName, legacyFileName]);
  } catch (error) {
    throw error;
  }

  onProgress(`Recherche cache ${coord.xKm}/${coord.yKm}`, 0.12);
  let pointCloud = await loadColorizedData(resolvedFileName);
  // Invalidate stale or grey-colored cache if CRS mismatches or uncolorized
  if (pointCloud) {
    if (pointCloud.crs !== coord.projection) {
      pointCloud = null;
    } else if (pointCloud.count > 100 && pointCloud.colors[0] === 128 && pointCloud.colors[1] === 128 && pointCloud.colors[2] === 128 && pointCloud.colors[99] === 128 && pointCloud.colors[198] === 128) {
      pointCloud = null;
    }
  }

  let terrainMesh = await loadTerrainData(resolvedFileName);
  const shouldSaveColorizedCache = !pointCloud;
  const shouldSaveTerrainCache = !terrainMesh;

  if (!pointCloud) {
    onProgress(`Décompression LAS ${coord.xKm}/${coord.yKm}`, 0.2);
    pointCloud = await processPointCloudInWorker(
      fileBuffer,
      (detail, progress = 0) => {
        onProgress(`${detail} ${coord.xKm}/${coord.yKm}`, 0.2 + (progress / 100) * 0.5);
      },
      coord.projection,
    );
  }

  if (!terrainMesh) {
    onProgress(`Génération heightmap ${coord.xKm}/${coord.yKm}`, 0.75);
    terrainMesh = await generateHeightmap(pointCloud, 1.0);
  }

  onProgress(`Tuile prête ${coord.xKm}/${coord.yKm}`, 0.92);
  return {
    coord,
    fileName: resolvedFileName,
    pointCloud,
    terrainMesh,
    shouldSaveColorizedCache,
    shouldSaveTerrainCache,
  };
}

/**
 * Charge les données de scène LiDAR complètes (nuage de points et maillage de terrain),
 * gérant le chargement multi-tuiles simultané, l'échantillonnage de budget et le cache OPFS/IndexedDB.
 */
export async function loadViewerSceneData(
  tileCoords: TileCoord[],
  setStatus: ViewerStatusReporter,
  options?: ViewerSceneLoadOptions,
): Promise<ViewerSceneData> {
  if (tileCoords.length === 0) {
    throw new Error('Aucune coordonnée de tuile fournie pour charger la scène viewer.');
  }

  const multiTilePointCap = resolveMultiTilePointCap(tileCoords.length, options);
  const reporter = createSceneProgressReporter(tileCoords, setStatus);
  const concurrency = getSceneLoadConcurrency(tileCoords.length);

  reporter.updateSceneProgress('Chargement des tuiles LiDAR...', 0.05);

  const tiles = await mapWithConcurrency(tileCoords, concurrency, (coord, index) => {
    return loadViewerTile(coord, (detail, progress) => {
      reporter.updateTileProgress(index, detail, progress);
    });
  });

  reporter.updateSceneProgress('Fusion des nuages de points...', 0.82);
  const mergedPointCloud = mergePointClouds(tiles, multiTilePointCap);

  reporter.updateSceneProgress('Génération du maillage de terrain...', 0.88);
  let mergedTerrainMesh = mergeTerrainMeshes(tiles, mergedPointCloud);
  if (!mergedTerrainMesh) {
    reporter.updateSceneProgress('Recalcul de la heightmap de la scène...', 0.9);
    mergedTerrainMesh = await generateHeightmap(mergedPointCloud, 1.0);
  }

  const cacheWrites: CacheWriteTask[] = [];
  for (const tile of tiles) {
    if (tile.shouldSaveColorizedCache) {
      cacheWrites.push({
        label: `Cache couleur ${tile.coord.xKm}/${tile.coord.yKm}`,
        task: () => saveColorizedData(tile.fileName, tile.pointCloud),
      });
    }
    if (tile.shouldSaveTerrainCache) {
      cacheWrites.push({
        label: `Cache terrain ${tile.coord.xKm}/${tile.coord.yKm}`,
        task: () => saveTerrainData(tile.fileName, tile.terrainMesh),
      });
    }
  }

  const tileFileLabel = tiles.length === 1
    ? tiles[0]!.fileName
    : `${tiles.length} tuiles (${tiles.map((tile) => `${tile.coord.xKm}/${tile.coord.yKm}`).join(', ')})`;

  return {
    pointCloud: mergedPointCloud,
    terrainMesh: mergedTerrainMesh,
    cacheWrites,
    tileFileLabel,
  };
}