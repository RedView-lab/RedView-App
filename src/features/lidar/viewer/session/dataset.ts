import type { DetectedCrs, PointCloudBounds, PointCloudData, TileCoord } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { loadTerrainData, readTileHead, saveTerrainData, type TerrainCache } from '../../lib/storage';
import { openLodTile, type OpenedLodTile } from '../../lib/lodCache';
import { generateHeightmap } from '../heightmap';
import {
  buildLodTileInWorker,
  getDefaultDecodeWorkerCount,
  loadTileFromOPFS,
  processPointCloudInWorker,
  upgradeLodTileInWorker,
  type ViewerStatusReporter,
} from '../runtime';
import {
  buildTileFileCandidates,
  createSceneProgressReporter,
  getSceneLoadConcurrency,
  mapWithConcurrency,
  type ViewerSceneLoadOptions,
} from './datasetPointCap';
import { mergeTerrainMeshes, unionBounds, type LoadedViewerTile, type SceneTerrain } from './datasetMerge';
import { DECODE_BYTES_PER_POINT, getSceneMemoryBudgetBytes, readLasPointCount, TileLoadPipeline } from './sceneMemoryBudget';

export type { ViewerSceneLoadOptions } from './datasetPointCap';

interface CacheWriteTask {
  label: string;
  task: () => Promise<void>;
}

export interface ViewerSceneData {
  /** One streamed LOD octree per tile (header + node table; blocks read on demand). */
  tiles: OpenedLodTile[];
  /** Absolute union bounds of the scene. */
  bounds: PointCloudBounds;
  totalPoints: number;
  crs: DetectedCrs;
  /**
   * Resolves once the terrain mesh is ready. Kept as a promise so the caller
   * can initialise the GPU while the heightmap is still being generated.
   */
  terrainMesh: Promise<SceneTerrain>;
  cacheWrites: CacheWriteTask[];
  tileFileLabel: string;
}

interface PendingViewerTile {
  coord: TileCoord;
  fileName: string;
  lod: OpenedLodTile;
  terrainMesh: Promise<TerrainCache>;
  shouldSaveTerrainCache: boolean;
}

/** A tile after the decode stage, waiting for its LOD build. */
interface DecodedViewerTile {
  pointCloud: PointCloudData;
  terrainMesh: Promise<TerrainCache>;
}

interface SceneLoadMemory {
  pipeline: TileLoadPipeline;
  budgetBytes: number;
}

/**
 * Orthophoto colourisation leaves points it could not colour mid-grey
 * (128,128,128); a mostly grey tile means the imagery failed to load and
 * must not be frozen into the cache.
 */
function looksUncolourised(pc: PointCloudData): boolean {
  if (pc.embeddedRgb || pc.count < 100) return false;
  const step = Math.max(1, Math.floor(pc.count / 2000));
  let samples = 0;
  let grey = 0;
  for (let i = 0; i < pc.count; i += step) {
    samples++;
    const c = i * 3;
    if (pc.colors[c] === 128 && pc.colors[c + 1] === 128 && pc.colors[c + 2] === 128) grey++;
  }
  return grey > samples * 0.5;
}

/** Point count from the stored tile's LAS header, without reading the file. */
async function storedTilePointCount(fileNames: string[]): Promise<number | null> {
  for (const name of fileNames) {
    const head = await readTileHead(name, 375);
    if (head) return readLasPointCount(head);
  }
  return null;
}

async function loadViewerTile(
  coord: TileCoord,
  onProgress: (detail: string, progress: number) => void,
  memory: SceneLoadMemory,
): Promise<PendingViewerTile> {
  const { fileName, legacyFileName } = buildTileFileCandidates(coord);
  const tileVars = { x: coord.xKm, y: coord.yKm };

  onProgress(translateAppText('Recherche cache {{x}}/{{y}}', tileVars), 0.05);
  const [openedLod, cachedTerrain] = await Promise.all([openLodTile(fileName), loadTerrainData(fileName)]);
  let cachedLod = openedLod;
  if (!cachedLod && cachedTerrain) {
    // A cache from the previous format is upgraded in a second or two;
    // rebuilding it would decode and colourise the whole tile again.
    onProgress(translateAppText('Mise à niveau du cache LOD {{x}}/{{y}}', tileVars), 0.3);
    cachedLod = await upgradeLodTileInWorker(fileName);
  }
  if (cachedLod && cachedTerrain && cachedLod.header.crs === coord.projection) {
    onProgress(translateAppText('Tuile prête {{x}}/{{y}}', tileVars), 0.92);
    return {
      coord,
      fileName,
      lod: cachedLod,
      terrainMesh: Promise.resolve(cachedTerrain),
      shouldSaveTerrainCache: false,
    };
  }

  // First visit (or stale cache): decode + colourise once, then store the LOD
  // octree — in the scene's load pipeline, sized by the header's point count
  // (unknown: the whole budget, so the tile runs alone).
  const pointCount = (await storedTilePointCount([fileName, legacyFileName]))
    ?? Math.ceil(memory.budgetBytes / DECODE_BYTES_PER_POINT);
  return memory.pipeline.run(
    pointCount,
    () => decodeViewerTile(coord, fileName, legacyFileName, cachedTerrain, onProgress),
    (decoded) => buildViewerTile(coord, fileName, decoded, !cachedTerrain, onProgress),
  );
}

/** Decode stage: one tile at a time, on every decode worker. */
async function decodeViewerTile(
  coord: TileCoord,
  fileName: string,
  legacyFileName: string,
  cachedTerrain: TerrainCache | null,
  onProgress: (detail: string, progress: number) => void,
): Promise<DecodedViewerTile> {
  const tileVars = { x: coord.xKm, y: coord.yKm };
  onProgress(translateAppText('Lecture OPFS {{x}}/{{y}}', tileVars), 0.12);
  // Handed over: the decoder drops the compressed file as soon as its chunks are copied out.
  const file = { buffer: await loadTileFromOPFS([fileName, legacyFileName]) as ArrayBuffer | null };
  onProgress(translateAppText('Décompression LAS {{x}}/{{y}}', tileVars), 0.2);
  const pointCloud = await processPointCloudInWorker(
    file,
    (detail, progress = 0) => {
      onProgress(`${detail} ${coord.xKm}/${coord.yKm}`, 0.2 + (progress / 100) * 0.5);
    },
    coord.projection,
    { decodeWorkers: getDefaultDecodeWorkerCount() },
  );

  onProgress(translateAppText('Génération du relief {{x}}/{{y}}', tileVars), 0.72);
  // generateHeightmap copies the ground points synchronously, before the
  // arrays are handed over (detached) to the LOD worker in the build stage.
  const terrainMesh = cachedTerrain ? Promise.resolve(cachedTerrain) : generateHeightmap(pointCloud, 1.0);
  terrainMesh.catch(() => undefined);
  return { pointCloud, terrainMesh };
}

/** Build stage: the LOD octree of one tile at a time (one worker), written to OPFS. */
async function buildViewerTile(
  coord: TileCoord,
  fileName: string,
  { pointCloud, terrainMesh }: DecodedViewerTile,
  shouldSaveTerrainCache: boolean,
  onProgress: (detail: string, progress: number) => void,
): Promise<PendingViewerTile> {
  const tileVars = { x: coord.xKm, y: coord.yKm };
  onProgress(translateAppText('Index LOD {{x}}/{{y}}', tileVars), 0.8);
  const persist = !looksUncolourised(pointCloud);
  if (!persist) console.warn(`[Viewer] Tile ${coord.xKm}/${coord.yKm} looks uncolourised; LOD cache kept in memory only.`);
  const lod = await buildLodTileInWorker(fileName, pointCloud, { persist });

  onProgress(translateAppText('Tuile prête {{x}}/{{y}}', tileVars), 0.92);
  return { coord, fileName, lod, terrainMesh, shouldSaveTerrainCache };
}

/**
 * Charge la scène LiDAR (une octree LOD par tuile, lue à la demande, et le
 * maillage de terrain fusionné). Aucune décimation : la densité complète
 * reste disponible près de la caméra quel que soit le nombre de tuiles.
 */
export async function loadViewerSceneData(
  tileCoords: TileCoord[],
  setStatus: ViewerStatusReporter,
  options?: ViewerSceneLoadOptions,
): Promise<ViewerSceneData> {
  if (tileCoords.length === 0) {
    throw new Error(translateAppText('Aucune coordonnée de tuile fournie pour charger la scène viewer.'));
  }

  const reporter = createSceneProgressReporter(tileCoords, setStatus);
  const concurrency = getSceneLoadConcurrency(tileCoords.length, options?.deviceMemoryGiB);

  reporter.updateSceneProgress(translateAppText('Chargement des tuiles LiDAR...'), 0.05);

  const budgetBytes = getSceneMemoryBudgetBytes(options?.deviceMemoryGiB);
  const memory: SceneLoadMemory = { pipeline: new TileLoadPipeline(budgetBytes), budgetBytes };
  const pendingTiles = await mapWithConcurrency(tileCoords, concurrency, (coord, index) => {
    return loadViewerTile(coord, (detail, progress) => {
      reporter.updateTileProgress(index, detail, progress);
    }, memory);
  });

  const bounds = unionBounds(pendingTiles.map((tile) => tile.lod.header.bounds));
  const terrainMesh = (async (): Promise<SceneTerrain> => {
    const meshes = await Promise.all(pendingTiles.map((tile) => tile.terrainMesh));
    const tiles: LoadedViewerTile[] = pendingTiles.map((tile, index) => ({
      coord: tile.coord,
      bounds: tile.lod.header.bounds,
      terrainMesh: meshes[index]!,
    }));
    return mergeTerrainMeshes(tiles, bounds);
  })();
  // Avoid an unhandled rejection before the caller awaits it.
  terrainMesh.catch(() => undefined);

  const cacheWrites: CacheWriteTask[] = [];
  for (const tile of pendingTiles) {
    if (tile.shouldSaveTerrainCache) {
      cacheWrites.push({
        label: `Cache terrain ${tile.coord.xKm}/${tile.coord.yKm}`,
        task: async () => saveTerrainData(tile.fileName, await tile.terrainMesh),
      });
    }
  }

  const tileFileLabel = pendingTiles.length === 1
    ? pendingTiles[0]!.fileName
    : translateAppText('{{count}} tuiles ({{list}})', {
      count: pendingTiles.length,
      list: pendingTiles.map((tile) => `${tile.coord.xKm}/${tile.coord.yKm}`).join(', '),
    });

  return {
    tiles: pendingTiles.map((tile) => tile.lod),
    bounds,
    totalPoints: pendingTiles.reduce((sum, tile) => sum + tile.lod.header.pointCount, 0),
    crs: pendingTiles[0]!.lod.header.crs,
    terrainMesh,
    cacheWrites,
    tileFileLabel,
  };
}
