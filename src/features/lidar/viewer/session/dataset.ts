import type { DetectedCrs, PointCloudBounds, PointCloudData, TileCoord } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { loadTerrainData, readTileHead, saveTerrainData, type TerrainCache } from '../../lib/storage';
import { openLodTile, type OpenedLodTile } from '../../lib/lodCache';
import { generateHeightmap } from '../heightmap';
import { loadTileFromOPFS, type ViewerStatusReporter } from '../runtime';
import {
  buildLodTileInWorker,
  getDefaultDecodeWorkerCount,
  processPointCloudInWorker,
  upgradeLodTileInWorker,
} from './pointCloudWorkers';
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
  /** Emprise absolue réunie de la scène. */
  bounds: PointCloudBounds;
  totalPoints: number;
  crs: DetectedCrs;
  /**
   * Se résout une fois le maillage du terrain prêt. Gardé en promesse pour que
   * l'appelant puisse initialiser le GPU pendant que la heightmap se génère encore.
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

/** Une tuile après l'étape de décodage, en attente de la construction de son LOD. */
interface DecodedViewerTile {
  pointCloud: PointCloudData;
  terrainMesh: Promise<TerrainCache>;
}

interface SceneLoadMemory {
  pipeline: TileLoadPipeline;
  budgetBytes: number;
}

/**
 * La colorisation par orthophoto laisse en gris moyen (128,128,128) les points
 * qu'elle n'a pas pu colorer ; une tuile surtout grise signifie que l'imagerie
 * n'a pas pu se charger et ne doit pas être figée dans le cache.
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

/** Nombre de points d'après l'en-tête LAS de la tuile stockée, sans lire le fichier. */
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
    // Un cache de l'ancien format est mis à niveau en une ou deux secondes ;
    // le reconstruire décoderait et coloriserait à nouveau toute la tuile.
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

  // Première visite (ou cache périmé) : décoder + coloriser une fois, puis stocker
  // l'octree LOD — dans le pipeline de chargement de la scène, dimensionné par le
  // nombre de points de l'en-tête (inconnu : tout le budget, la tuile passe donc seule).
  const pointCount = (await storedTilePointCount([fileName, legacyFileName]))
    ?? Math.ceil(memory.budgetBytes / DECODE_BYTES_PER_POINT);
  return memory.pipeline.run(
    pointCount,
    () => decodeViewerTile(coord, fileName, legacyFileName, cachedTerrain, onProgress),
    (decoded) => buildViewerTile(coord, fileName, decoded, !cachedTerrain, onProgress),
  );
}

/** Étape de décodage : une tuile à la fois, sur chaque worker de décodage. */
async function decodeViewerTile(
  coord: TileCoord,
  fileName: string,
  legacyFileName: string,
  cachedTerrain: TerrainCache | null,
  onProgress: (detail: string, progress: number) => void,
): Promise<DecodedViewerTile> {
  const tileVars = { x: coord.xKm, y: coord.yKm };
  onProgress(translateAppText('Lecture OPFS {{x}}/{{y}}', tileVars), 0.12);
  // Transmis : le décodeur libère le fichier compressé dès que ses chunks sont copiés.
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
  // generateHeightmap copie les points sol de façon synchrone, avant que les
  // tableaux soient transmis (détachés) au worker LOD dans l'étape de construction.
  const terrainMesh = cachedTerrain ? Promise.resolve(cachedTerrain) : generateHeightmap(pointCloud, 1.0);
  terrainMesh.catch(() => undefined);
  return { pointCloud, terrainMesh };
}

/** Étape de construction : l'octree LOD d'une tuile à la fois (un worker), écrit dans l'OPFS. */
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
  // Éviter un rejet non géré avant que l'appelant ne l'attende.
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
