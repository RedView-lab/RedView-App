import type { AltitudeRef, CachedTileInfo, DetectedCrs, Territory, TileCoord } from '../types';
import { translateAppText } from '@/shared/i18n/config';
import { errorMessage, errorName } from '@/shared/lib/errors';
import { parseTileFootprint, tileCoordFileName } from './coordConvert';
import { LIDAR_OPFS_DIR, colourRevisionSuffix, lodCacheKey } from './lodCache';

const LIDAR_DIR = LIDAR_OPFS_DIR;
const CACHE_NAME = 'redview-lidar-hd-v1';
const inMemoryTileCache = new Map<string, ArrayBuffer>();
const MAX_TERRAIN_CACHE_BYTES = 256 * 1024 * 1024;

let opfsAvailable: boolean | null = null;

async function getLidarDir(): Promise<FileSystemDirectoryHandle | null> {
  if (opfsAvailable === false) return null;
  if (typeof navigator === 'undefined' || !navigator?.storage?.getDirectory) {
    opfsAvailable = false;
    return null;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(LIDAR_DIR, { create: true });
    opfsAvailable = true;
    return dir;
  } catch (err) {
    console.warn(`[LiDAR storage] OPFS unavailable or blocked by browser security (${errorMessage(err)}), using CacheStorage fallback.`);
    opfsAvailable = false;
    return null;
  }
}

async function getLidarCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function removeFileIfPresent(dir: FileSystemDirectoryHandle | null, fileName: string): Promise<void> {
  if (!dir) return;
  try {
    await dir.removeEntry(fileName);
  } catch {
    /* fichier absent, ignorer */
  }
}

async function writeBufferChunk(
  writable: FileSystemWritableFileStream,
  data: ArrayBuffer | ArrayBufferView,
): Promise<void> {
  await writable.write(data as FileSystemWriteChunkType);
}

function tileKey(coord: TileCoord): string {
  return tileCoordFileName(coord);
}

export function hasValidLasSignature(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  try {
    return new DataView(data).getUint32(0, false) === 0x4C415346;
  } catch {
    return false;
  }
}

export function hasValidZipSignature(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  try {
    const magic = new DataView(data).getUint32(0, false);
    return magic === 0x504B0304 || magic === 0x504B0506 || magic === 0x504B0708;
  } catch {
    return false;
  }
}

/** Le quota de stockage de l'origine est épuisé : la tuile ne peut pas être gardée pour le viewer. */
export class StorageFullError extends Error {
  constructor() {
    super(translateAppText('Stockage local plein : supprimez des tuiles LiDAR pour libérer de la place.'));
    this.name = 'StorageFullError';
  }
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}

let persistenceRequested = false;

/**
 * Demande une fois par page le stockage persistant : un stockage best-effort
 * peut être évincé sous pression disque (Chromium) ou après 7 jours sans visite
 * (Safari), emportant des gigaoctets de tuiles téléchargées. Chromium décide
 * sans demander, Firefox demande à l'utilisateur — d'où la demande au
 * téléchargement, pas au chargement.
 */
export function requestPersistentStorage(): void {
  if (persistenceRequested || typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  persistenceRequested = true;
  void navigator.storage.persisted()
    .then((persisted) => persisted || navigator.storage.persist())
    .then((granted) => {
      if (!granted) console.info('[LiDAR storage] Persistent storage not granted: cached tiles may be evicted under storage pressure.');
    })
    .catch(() => undefined);
}

export async function saveTile(coord: TileCoord, data: ArrayBuffer): Promise<void> {
  if (!hasValidLasSignature(data)) {
    throw new Error(translateAppText('Tuile LiDAR corrompue : signature LAS/COPC invalide.'));
  }
  const fileName = tileKey(coord);
  requestPersistentStorage();

  // 1. Essayer l'OPFS
  const dir = await getLidarDir();
  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
      // Une écriture peut annoncer un succès et laisser un fichier tronqué (bug
      // WebKit 248719, WebKit de Playwright sous Windows) : relue comme corrompue
      // puis supprimée, la tuile serait perdue pour le viewer. Vérifier la taille ne coûte aucune lecture.
      const written = (await fileHandle.getFile()).size;
      if (written === data.byteLength) return;
      await dir.removeEntry(fileName).catch(() => undefined);
      console.warn(`[LiDAR storage] OPFS kept ${written} of ${data.byteLength} bytes for ${fileName}, falling back to CacheStorage.`);
    } catch (err) {
      // `getFileHandle({ create })` a déjà créé le fichier : vide, il masquerait à la lecture la copie de CacheStorage.
      await dir.removeEntry(fileName).catch(() => undefined);
      // Le viewer (une autre page) ne lit les tuiles que dans le stockage de
      // l'origine : gardée dans la mémoire de cette page, une tuile qu'il ne peut pas ouvrir est un téléchargement raté.
      if (isQuotaExceeded(err)) throw new StorageFullError();
      console.warn(`[LiDAR storage] OPFS write failed for ${fileName}, falling back to CacheStorage:`, err);
    }
  }

  // 2. Essayer CacheStorage
  const cache = await getLidarCache();
  if (cache) {
    try {
      const response = new Response(data, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Redview-Cached-At': String(Date.now()),
        },
      });
      await cache.put(`/lidar-hd/${fileName}`, response);
      return;
    } catch (err) {
      if (isQuotaExceeded(err)) throw new StorageFullError();
      console.warn(`[LiDAR storage] CacheStorage put failed for ${fileName}, keeping in memory:`, err);
    }
  }

  // 3. Repli : en mémoire
  inMemoryTileCache.set(fileName, data);
}

export async function loadTile(coord: TileCoord): Promise<ArrayBuffer | null> {
  return loadTileByFileName(tileKey(coord));
}

export async function loadTileByFileName(fileName: string): Promise<ArrayBuffer | null> {
  // 1. Essayer l'OPFS
  try {
    const dir = await getLidarDir();
    if (dir) {
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const data = await file.arrayBuffer();
      if (hasValidLasSignature(data)) return data;
      // Seul le fichier OPFS est en cause (écriture ratée d'une version précédente) :
      // la copie de CacheStorage, si elle existe, est lue ensuite.
      console.warn(`[LiDAR storage] Invalid signature in cached tile ${fileName}; deleting corrupted OPFS entry.`);
      await removeFileIfPresent(dir, fileName);
    }
  } catch {
    // Absent de l'OPFS ou erreur OPFS
  }

  // 2. Essayer CacheStorage
  try {
    const cache = await getLidarCache();
    if (cache) {
      const match = await cache.match(`/lidar-hd/${fileName}`);
      if (match) {
        const data = await match.arrayBuffer();
        if (!hasValidLasSignature(data)) {
          console.warn(`[LiDAR storage] Invalid signature in CacheStorage tile ${fileName}; deleting entry.`);
          await cache.delete(`/lidar-hd/${fileName}`);
          return null;
        }
        return data;
      }
    }
  } catch {
    // Erreur CacheStorage
  }

  // 3. Essayer la mémoire
  const mem = inMemoryTileCache.get(fileName);
  if (mem && hasValidLasSignature(mem)) {
    return mem;
  }

  return null;
}

/**
 * Premiers `byteCount` octets d'une tuile stockée (son en-tête LAS) sans lire
 * tout le fichier, depuis l'OPFS puis CacheStorage ; null si absente.
 */
export async function readTileHead(fileName: string, byteCount: number): Promise<ArrayBuffer | null> {
  try {
    const dir = await getLidarDir();
    if (dir) return await (await (await dir.getFileHandle(fileName)).getFile()).slice(0, byteCount).arrayBuffer();
  } catch {
    // Absent de l'OPFS
  }
  try {
    const match = await (await getLidarCache())?.match(`/lidar-hd/${fileName}`);
    if (match) return (await match.blob()).slice(0, byteCount).arrayBuffer();
  } catch {
    // Erreur CacheStorage
  }
  return inMemoryTileCache.get(fileName)?.slice(0, byteCount) ?? null;
}

export async function hasTile(coord: TileCoord): Promise<boolean> {
  const fileName = tileKey(coord);

  try {
    const dir = await getLidarDir();
    if (dir) {
      await dir.getFileHandle(fileName);
      return true;
    }
  } catch {
    // absent de l'OPFS
  }

  try {
    const cache = await getLidarCache();
    if (cache) {
      const match = await cache.match(`/lidar-hd/${fileName}`);
      if (match) return true;
    }
  } catch {}

  return inMemoryTileCache.has(fileName);
}

export async function deleteTile(coord: TileCoord): Promise<void> {
  const fileName = tileKey(coord);
  const companion = lodCacheKey(fileName);
  const terrain = terrainKey(fileName);

  // 1. Supprimer de l'OPFS
  try {
    const dir = await getLidarDir();
    if (dir) {
      await removeFileIfPresent(dir, companion);
      await removeFileIfPresent(dir, terrain);
      await removeLegacyDerivedCaches(dir, fileName);
      await dir.removeEntry(fileName);
    }
  } catch (err) {
    if (errorName(err) !== 'NotFoundError') {
      console.warn(`[LiDAR storage] OPFS delete error for ${fileName}:`, err);
    }
  }

  // 2. Supprimer de CacheStorage
  try {
    const cache = await getLidarCache();
    if (cache) {
      await cache.delete(`/lidar-hd/${fileName}`);
      await cache.delete(`/lidar-hd/${companion}`);
      await cache.delete(`/lidar-hd/${terrain}`);
    }
  } catch {}

  // 3. Supprimer de la mémoire
  inMemoryTileCache.delete(fileName);
}

const TERRITORIES: ReadonlySet<string> = new Set<Territory>(['FXX', 'REU', 'CH', 'NZ', 'JP', 'NL', 'BE']);
const ALTITUDE_REFS: ReadonlySet<string> = new Set<AltitudeRef>(['IGN69', 'IGN78', 'REUN89', 'LN02', 'NZVD2016', 'TP', 'NAP', 'TAW']);
const DETECTED_CRS = /^(?:LAMB93|RGR92UTM40S|CH1903_LV95|NZTM2000|RD_NEW|BL72|JGD2011_ZONE_(?:0[1-9]|1[0-9]))$/;

const isTerritory = (value: string): value is Territory => TERRITORIES.has(value);
const isAltitudeRef = (value: string): value is AltitudeRef => ALTITUDE_REFS.has(value);
const isDetectedCrs = (value: string): value is DetectedCrs => DETECTED_CRS.test(value);

/**
 * Dalle d'un fichier du cache (nom écrit par tileCoordFileName), null pour
 * tout autre fichier du dossier.
 */
export function parseCachedTileName(name: string, sizeBytes: number, cachedAt: number): CachedTileInfo | null {
  // Dalle-fichier (Japon, NZ) : `…_<alt>~minX,minY,maxX,maxY.copc.laz`.
  const footprintMatch = name.match(/^(.+)~([-\d,]+)\.copc\.laz$/);
  const footprint = footprintMatch ? parseTileFootprint(footprintMatch[2]) : null;
  if (footprintMatch && !footprint) return null;
  const baseName = footprintMatch ? `${footprintMatch[1]}.copc.laz` : name;
  const match = baseName.match(/^LHD_(\w+)_([-\w]+)_([-\w]+)_PTS_(\w+)_(\w+)\.copc\.laz$/);
  if (!match) return null;

  const [, territory, xStr, yStr, projection, altRef] = match;
  const crs = territory === 'CH' ? 'CH1903_LV95' : territory === 'NZ' ? 'NZTM2000' : projection;
  if (!isTerritory(territory) || !isDetectedCrs(crs) || !isAltitudeRef(altRef)) return null;
  const isJapan = territory === 'JP';
  const isSwCorner = territory === 'CH' || territory === 'NZ' || isJapan || territory === 'NL' || territory === 'BE';

  let xKm = parseInt(xStr, 10);
  let yKm = parseInt(yStr, 10);
  if (isJapan) {
    xKm = xStr.startsWith('m') ? -parseInt(xStr.slice(1), 10) : xStr.startsWith('p') ? parseInt(xStr.slice(1), 10) : parseInt(xStr, 10);
    yKm = yStr.startsWith('m') ? -parseInt(yStr.slice(1), 10) : yStr.startsWith('p') ? parseInt(yStr.slice(1), 10) : parseInt(yStr, 10);
  }

  return {
    coord: {
      xKm,
      yKm: yKm - (isSwCorner ? 0 : 1),
      territory,
      projection: crs,
      altRef,
      ...(footprint ? { footprint } : {}),
    },
    fileName: name,
    sizeBytes,
    cachedAt,
  };
}

export async function listCachedTiles(): Promise<CachedTileInfo[]> {
  const tilesMap = new Map<string, CachedTileInfo>();
  const parseTileName = (name: string, sizeBytes: number, cachedAt: number) => {
    const tile = parseCachedTileName(name, sizeBytes, cachedAt);
    if (tile) tilesMap.set(name, tile);
  };

  // 1. Vérifier l'OPFS
  try {
    const dir = await getLidarDir();
    if (dir) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        if (!name.endsWith('.laz')) continue;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          parseTileName(name, file.size, file.lastModified);
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[LiDAR storage] listCachedTiles OPFS error:', err);
  }

  // 2. Vérifier CacheStorage
  try {
    const cache = await getLidarCache();
    if (cache) {
      const keys = await cache.keys();
      for (const req of keys) {
        const parts = req.url.split('/lidar-hd/');
        if (parts.length < 2) continue;
        const name = parts[1]!;
        if (tilesMap.has(name)) continue;

        try {
          const res = await cache.match(req);
          if (res) {
            const size = parseInt(res.headers.get('content-length') || '0', 10);
            const cachedAt = parseInt(res.headers.get('x-redview-cached-at') || String(Date.now()), 10);
            parseTileName(name, size, cachedAt);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[LiDAR storage] listCachedTiles CacheStorage error:', err);
  }

  // 3. Vérifier la mémoire
  for (const [name, buf] of inMemoryTileCache.entries()) {
    if (!tilesMap.has(name)) {
      parseTileName(name, buf.byteLength, Date.now());
    }
  }

  return Array.from(tilesMap.values());
}

export async function getStorageUsage(): Promise<{ used: number; quota: number }> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
    }
  } catch {}
  return { used: 0, quota: 0 };
}

export async function clearAllTiles(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(LIDAR_DIR, { recursive: true });
    }
  } catch {}
  try {
    if (typeof caches !== 'undefined') {
      await caches.delete(CACHE_NAME);
    }
  } catch {}
  inMemoryTileCache.clear();
}

// --- Caches dérivés ---

// Caches par tuile remplacés : la v3 stockait des positions float32 absolues
// (ordonnées quantifiées à 0,5 m), la v4 des nuages décodés entiers ; le cache
// LOD (lodCache.ts) remplace les deux. Les maillages terrain v2 étaient construits
// à partir de points quantifiés, les v3 projetaient les points avec un pas qui ne
// correspondait pas à l'espacement des nœuds du maillage. Le LOD v1 n'avait pas
// de couleurs filtrées (normalement mis à niveau à l'ouverture, voir
// `upgradeLegacyLodTile` ; supprimé ici quand la tuile est supprimée ou reconstruite).
const LEGACY_DERIVED_SUFFIXES = ['.colorized_v3', '.colorized_v4', '.terrain_hd_v2', '.terrain_hd_v3', '.lod_v1'] as const;

// Une tuile dont les couleurs ont été révisées (`colourRevisionSuffix`) supprime
// aussi son cache terrain non révisé et son LOD v1 révisé.
function legacyDerivedKeys(baseName: string): string[] {
  const suffixes: string[] = [...LEGACY_DERIVED_SUFFIXES];
  const revision = colourRevisionSuffix(baseName);
  if (revision) suffixes.push(`.lod_v1${revision}`, '.terrain_hd_v4');
  return suffixes.map((suffix) => baseName.replace(/(\.copc)?\.laz$/, suffix));
}

async function removeLegacyDerivedCaches(dir: FileSystemDirectoryHandle | null, lazFileName: string): Promise<void> {
  for (const key of legacyDerivedKeys(lazFileName)) {
    await removeFileIfPresent(dir, key);
  }
}

// --- Cache des maillages terrain ---

function terrainKey(baseName: string): string {
  return baseName.replace(/\.copc\.laz$/, `.terrain_hd_v4${colourRevisionSuffix(baseName)}`);
}

export interface TerrainCache {
  vertices: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
}

export async function saveTerrainData(lazFileName: string, mesh: TerrainCache): Promise<void> {
  const dir = await getLidarDir();
  if (!dir) return;
  const fileName = terrainKey(lazFileName);
  await removeLegacyDerivedCaches(dir, lazFileName);
  const headerSize = 16;
  const vertBytes = mesh.vertexCount * 24;
  const colBytes = mesh.vertexCount * 4;
  const idxBytes = mesh.indexCount * 4;
  const hmBytes = mesh.gridWidth * mesh.gridHeight * 4;
  const totalSize = headerSize + vertBytes + colBytes + idxBytes + hmBytes;

  if (totalSize > MAX_TERRAIN_CACHE_BYTES) {
    console.log(`[LiDAR storage] Skip terrain cache for ${lazFileName}: ${(totalSize / 1024 / 1024).toFixed(1)} MB exceeds cap.`);
    await removeFileIfPresent(dir, fileName);
    return;
  }

  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);
  view.setUint32(0, mesh.vertexCount, true);
  view.setUint32(4, mesh.indexCount, true);
  view.setUint32(8, mesh.gridWidth, true);
  view.setUint32(12, mesh.gridHeight, true);

  try {
    const fh = await dir.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    try {
      await writeBufferChunk(w, header);
      await writeBufferChunk(w, new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, vertBytes));
      await writeBufferChunk(w, mesh.colors.subarray(0, colBytes));
      await writeBufferChunk(w, new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, idxBytes));
      await writeBufferChunk(w, new Uint8Array(mesh.heightGrid.buffer, mesh.heightGrid.byteOffset, hmBytes));
    } finally {
      await w.close();
    }
  } catch (err) {
    console.warn(`[LiDAR storage] Failed to write terrain cache:`, err);
  }
}

export async function loadTerrainData(lazFileName: string): Promise<TerrainCache | null> {
  try {
    const dir = await getLidarDir();
    if (!dir) return null;
    const fileName = terrainKey(lazFileName);
    const fh = await dir.getFileHandle(fileName);
    const file = await fh.getFile();
    if (file.size > MAX_TERRAIN_CACHE_BYTES) {
      console.log(`[LiDAR storage] Ignore oversized terrain cache for ${lazFileName}: ${(file.size / 1024 / 1024).toFixed(1)} MB.`);
      await removeFileIfPresent(dir, fileName);
      return null;
    }
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    if (buf.byteLength < 16) return null;
    const vertexCount = view.getUint32(0, true);
    const indexCount = view.getUint32(4, true);
    const gridWidth = view.getUint32(8, true);
    const gridHeight = view.getUint32(12, true);
    if (gridWidth === 0 || gridHeight === 0) return null;
    let offset = 16;
    const vertBytes = vertexCount * 24;
    const vertices = new Float32Array(buf.slice(offset, offset + vertBytes)); offset += vertBytes;
    const colBytes = vertexCount * 4;
    const colors = new Uint8Array(buf.slice(offset, offset + colBytes)); offset += colBytes;
    const idxBytes = indexCount * 4;
    const indices = new Uint32Array(buf.slice(offset, offset + idxBytes)); offset += idxBytes;
    const hmBytes = gridWidth * gridHeight * 4;
    if (offset + hmBytes > buf.byteLength) return null;
    const heightGrid = new Float32Array(buf.slice(offset, offset + hmBytes));
    return { vertices, colors, indices, vertexCount, indexCount, heightGrid, gridWidth, gridHeight };
  } catch {
    return null;
  }
}

// --- Cache des normales ---

function normalsKey(baseName: string): string {
  return baseName.replace(/\.copc\.laz$/, '.normals');
}

export async function saveNormalsData(lazFileName: string, normals: Float32Array): Promise<void> {
  const dir = await getLidarDir();
  if (!dir) return;
  try {
    const fh = await dir.getFileHandle(normalsKey(lazFileName), { create: true });
    const w = await fh.createWritable();
    await w.write(normals.buffer as ArrayBuffer);
    await w.close();
  } catch (err) {
    console.warn(`[LiDAR storage] Failed to write normals cache:`, err);
  }
}

export async function loadNormalsData(lazFileName: string, expectedCount: number): Promise<Float32Array | null> {
  try {
    const dir = await getLidarDir();
    if (!dir) return null;
    const fh = await dir.getFileHandle(normalsKey(lazFileName));
    const buf = await (await fh.getFile()).arrayBuffer();
    const normals = new Float32Array(buf);
    if (normals.length !== expectedCount * 3) return null;
    return normals;
  } catch {
    return null;
  }
}
