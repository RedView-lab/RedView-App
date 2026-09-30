import type { PointCloudData, TileCoord } from '../../types';
import {
  loadColorizedData,
  loadTerrainData,
  saveColorizedData,
  saveTerrainData,
  type TerrainCache,
} from '../../lib/storage';
import { generateHeightmap } from '../heightmap';
import {
  getDefaultDecodeWorkerCount,
  loadTileFromOPFS,
  processPointCloudInWorker,
  type ViewerStatusReporter,
} from '../runtime';
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
  /**
   * Resolves once the terrain mesh is ready. Kept as a promise so the caller
   * can build the octree while the heightmap is still being generated.
   */
  terrainMesh: Promise<TerrainCache>;
  cacheWrites: CacheWriteTask[];
  tileFileLabel: string;
}

interface PendingViewerTile extends Omit<LoadedViewerTile, 'terrainMesh'> {
  terrainMesh: Promise<TerrainCache>;
}

async function loadViewerTile(
  coord: TileCoord,
  onProgress: (detail: string, progress: number) => void,
  decodeWorkers: number,
): Promise<PendingViewerTile> {
  const { fileName, legacyFileName } = buildTileFileCandidates(coord);
  const resolvedFileName = fileName;

  onProgress(`Recherche cache ${coord.xKm}/${coord.yKm}`, 0.05);
  const [cachedPointCloud, cachedTerrainMesh] = await Promise.all([
    loadColorizedData(resolvedFileName),
    loadTerrainData(resolvedFileName),
  ]);
  let pointCloud = cachedPointCloud;
  // Invalidate stale or grey-colored cache if CRS mismatches or uncolorized
  if (pointCloud) {
    if (pointCloud.crs !== coord.projection) {
      pointCloud = null;
    } else if (pointCloud.count > 100 && pointCloud.colors[0] === 128 && pointCloud.colors[1] === 128 && pointCloud.colors[2] === 128 && pointCloud.colors[99] === 128 && pointCloud.colors[198] === 128) {
      pointCloud = null;
    }
  }

  const shouldSaveColorizedCache = !pointCloud;
  const shouldSaveTerrainCache = !cachedTerrainMesh;

  if (!pointCloud) {
    // The raw LAZ is only needed when the colorized cache is missing.
    onProgress(`Lecture OPFS ${coord.xKm}/${coord.yKm}`, 0.12);
    const fileBuffer = await loadTileFromOPFS([fileName, legacyFileName]);
    onProgress(`Décompression LAS ${coord.xKm}/${coord.yKm}`, 0.2);
    pointCloud = await processPointCloudInWorker(
      fileBuffer,
      (detail, progress = 0) => {
        onProgress(`${detail} ${coord.xKm}/${coord.yKm}`, 0.2 + (progress / 100) * 0.5);
      },
      coord.projection,
      { decodeWorkers },
    );
  }

  let terrainMesh: Promise<TerrainCache>;
  if (cachedTerrainMesh) {
    terrainMesh = Promise.resolve(cachedTerrainMesh);
  } else {
    onProgress(`Génération heightmap ${coord.xKm}/${coord.yKm}`, 0.75);
    terrainMesh = generateHeightmap(pointCloud, 1.0);
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

  const decodeWorkers = Math.max(1, Math.floor(getDefaultDecodeWorkerCount() / concurrency));
  const pendingTiles = await mapWithConcurrency(tileCoords, concurrency, (coord, index) => {
    return loadViewerTile(coord, (detail, progress) => {
      reporter.updateTileProgress(index, detail, progress);
    }, decodeWorkers);
  });

  reporter.updateSceneProgress('Fusion des nuages de points...', 0.82);
  const mergedPointCloud = mergePointClouds(pendingTiles, multiTilePointCap);

  const terrainMesh = (async (): Promise<TerrainCache> => {
    const meshes = await Promise.all(pendingTiles.map((tile) => tile.terrainMesh));
    const tiles: LoadedViewerTile[] = pendingTiles.map((tile, index) => ({ ...tile, terrainMesh: meshes[index]! }));
    return mergeTerrainMeshes(tiles, mergedPointCloud) ?? generateHeightmap(mergedPointCloud, 1.0);
  })();
  // Avoid an unhandled rejection before the caller awaits it.
  terrainMesh.catch(() => undefined);

  const cacheWrites: CacheWriteTask[] = [];
  for (const tile of pendingTiles) {
    if (tile.shouldSaveColorizedCache) {
      cacheWrites.push({
        label: `Cache couleur ${tile.coord.xKm}/${tile.coord.yKm}`,
        task: () => saveColorizedData(tile.fileName, tile.pointCloud),
      });
    }
    if (tile.shouldSaveTerrainCache) {
      cacheWrites.push({
        label: `Cache terrain ${tile.coord.xKm}/${tile.coord.yKm}`,
        task: async () => saveTerrainData(tile.fileName, await tile.terrainMesh),
      });
    }
  }

  const tileFileLabel = pendingTiles.length === 1
    ? pendingTiles[0]!.fileName
    : `${pendingTiles.length} tuiles (${pendingTiles.map((tile) => `${tile.coord.xKm}/${tile.coord.yKm}`).join(', ')})`;

  return {
    pointCloud: mergedPointCloud,
    terrainMesh,
    cacheWrites,
    tileFileLabel,
  };
}
