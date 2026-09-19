import type { TileCoord, CachedTileInfo, PointCloudData, DetectedCrs } from '../types';
import { buildTileFileName } from './coordConvert';

const LIDAR_DIR = 'lidar-hd';
const CACHE_NAME = 'redview-lidar-hd-v1';
const inMemoryTileCache = new Map<string, ArrayBuffer>();
const MAX_COLORIZED_CACHE_BYTES = 512 * 1024 * 1024;
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
  } catch (err: any) {
    console.warn(`[LiDAR storage] OPFS unavailable or blocked by browser security (${err?.message || err}), using CacheStorage fallback.`);
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
    /* file absent, ignore */
  }
}

async function writeBufferChunk(
  writable: FileSystemWritableFileStream,
  data: ArrayBuffer | ArrayBufferView,
): Promise<void> {
  await writable.write(data as FileSystemWriteChunkType);
}

function tileKey(coord: TileCoord): string {
  return `${buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef)}.copc.laz`;
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

export async function saveTile(coord: TileCoord, data: ArrayBuffer): Promise<void> {
  if (!hasValidLasSignature(data)) {
    throw new Error('Tuile LiDAR corrompue: signature LAS/COPC invalide.');
  }
  const fileName = tileKey(coord);

  // 1. Try OPFS
  const dir = await getLidarDir();
  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
      return;
    } catch (err) {
      console.warn(`[LiDAR storage] OPFS write failed for ${fileName}, falling back to CacheStorage:`, err);
    }
  }

  // 2. Try CacheStorage
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
      console.warn(`[LiDAR storage] CacheStorage put failed for ${fileName}, keeping in memory:`, err);
    }
  }

  // 3. Fallback: In-memory
  inMemoryTileCache.set(fileName, data);
}

export async function loadTile(coord: TileCoord): Promise<ArrayBuffer | null> {
  return loadTileByFileName(tileKey(coord), coord);
}

export async function loadTileByFileName(fileName: string, coordHint?: TileCoord): Promise<ArrayBuffer | null> {
  // 1. Try OPFS
  try {
    const dir = await getLidarDir();
    if (dir) {
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const data = await file.arrayBuffer();
      if (!hasValidLasSignature(data)) {
        console.warn(`[LiDAR storage] Invalid signature in cached tile ${fileName}; deleting corrupted entry.`);
        if (coordHint) await deleteTile(coordHint);
        return null;
      }
      return data;
    }
  } catch {
    // Not in OPFS or OPFS error
  }

  // 2. Try CacheStorage
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
    // CacheStorage error
  }

  // 3. Try In-memory
  const mem = inMemoryTileCache.get(fileName);
  if (mem && hasValidLasSignature(mem)) {
    return mem;
  }

  return null;
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
    // not in OPFS
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
  const companion = colorizedKey(fileName);
  const terrain = terrainKey(fileName);

  // 1. Delete from OPFS
  try {
    const dir = await getLidarDir();
    if (dir) {
      await removeFileIfPresent(dir, companion);
      await removeFileIfPresent(dir, terrain);
      await dir.removeEntry(fileName);
    }
  } catch (err: any) {
    if (err && err.name !== 'NotFoundError') {
      console.warn(`[LiDAR storage] OPFS delete error for ${fileName}:`, err);
    }
  }

  // 2. Delete from CacheStorage
  try {
    const cache = await getLidarCache();
    if (cache) {
      await cache.delete(`/lidar-hd/${fileName}`);
      await cache.delete(`/lidar-hd/${companion}`);
      await cache.delete(`/lidar-hd/${terrain}`);
    }
  } catch {}

  // 3. Delete from in-memory
  inMemoryTileCache.delete(fileName);
}

export async function listCachedTiles(): Promise<CachedTileInfo[]> {
  const tilesMap = new Map<string, CachedTileInfo>();

  const parseTileName = (name: string, sizeBytes: number, cachedAt: number) => {
    const match = name.match(/^LHD_(\w+)_([-\w]+)_([-\w]+)_PTS_(\w+)_(\w+)\.copc\.laz$/);
    if (!match) return;

    const [, territory, xStr, yStr, projection, altRef] = match;
    const isSwiss = territory === 'CH';
    const isNz = territory === 'NZ';
    const isJapan = territory === 'JP';
    const isSwCorner = isSwiss || isNz || isJapan;

    let xKm = parseInt(xStr, 10);
    let yKm = parseInt(yStr, 10);
    if (isJapan) {
      xKm = xStr.startsWith('m') ? -parseInt(xStr.slice(1), 10) : xStr.startsWith('p') ? parseInt(xStr.slice(1), 10) : parseInt(xStr, 10);
      yKm = yStr.startsWith('m') ? -parseInt(yStr.slice(1), 10) : yStr.startsWith('p') ? parseInt(yStr.slice(1), 10) : parseInt(yStr, 10);
    }

    tilesMap.set(name, {
      coord: {
        xKm,
        yKm: yKm - (isSwCorner ? 0 : 1),
        territory: territory as any,
        projection: (isSwiss ? 'CH1903_LV95' : isNz ? 'NZTM2000' : projection) as any,
        altRef: altRef as any,
      },
      fileName: name,
      sizeBytes,
      cachedAt,
    });
  };

  // 1. Check OPFS
  try {
    const dir = await getLidarDir();
    if (dir) {
      for await (const [name, handle] of (dir as any).entries()) {
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

  // 2. Check CacheStorage
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

  // 3. Check inMemory
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

// --- Colorized point cloud cache ---

function colorizedKey(baseName: string): string {
  return baseName.replace(/(\.copc)?\.laz$/, '.colorized_v3');
}

export async function saveColorizedData(lazFileName: string, pc: PointCloudData): Promise<void> {
  const dir = await getLidarDir();
  if (!dir) return;
  const fileName = colorizedKey(lazFileName);
  const crsBytes = new TextEncoder().encode(pc.crs);

  const headerSize = 4 + 48 + 1 + crsBytes.length;
  const posBytes = pc.count * 12;
  const colBytes = pc.count * 3;
  const clsBytes = pc.count;
  const totalSize = headerSize + posBytes + colBytes + clsBytes;

  if (totalSize > MAX_COLORIZED_CACHE_BYTES) {
    console.log(`[LiDAR storage] Skip colorized cache for ${lazFileName}: ${(totalSize / 1024 / 1024).toFixed(1)} MB exceeds cap.`);
    await removeFileIfPresent(dir, fileName);
    return;
  }

  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);
  let offset = 0;

  view.setUint32(offset, pc.count, true); offset += 4;
  view.setFloat64(offset, pc.bounds.minX, true); offset += 8;
  view.setFloat64(offset, pc.bounds.minY, true); offset += 8;
  view.setFloat64(offset, pc.bounds.minZ, true); offset += 8;
  view.setFloat64(offset, pc.bounds.maxX, true); offset += 8;
  view.setFloat64(offset, pc.bounds.maxY, true); offset += 8;
  view.setFloat64(offset, pc.bounds.maxZ, true); offset += 8;
  view.setUint8(offset, crsBytes.length); offset += 1;
  new Uint8Array(header, offset, crsBytes.length).set(crsBytes);

  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writeBufferChunk(writable, header);
      await writeBufferChunk(writable, new Uint8Array(pc.positions.buffer, pc.positions.byteOffset, posBytes));
      await writeBufferChunk(writable, pc.colors.subarray(0, colBytes));
      await writeBufferChunk(writable, pc.classifications.subarray(0, clsBytes));
    } finally {
      await writable.close();
    }
  } catch (err) {
    console.warn(`[LiDAR storage] Failed to write colorized cache:`, err);
  }
}

export async function loadColorizedData(lazFileName: string): Promise<PointCloudData | null> {
  try {
    const dir = await getLidarDir();
    if (!dir) return null;
    const fileName = colorizedKey(lazFileName);
    const fileHandle = await dir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    if (file.size > MAX_COLORIZED_CACHE_BYTES) {
      console.log(`[LiDAR storage] Ignore oversized colorized cache for ${lazFileName}: ${(file.size / 1024 / 1024).toFixed(1)} MB.`);
      await removeFileIfPresent(dir, fileName);
      return null;
    }
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    let offset = 0;

    const count = view.getUint32(offset, true); offset += 4;
    const minX = view.getFloat64(offset, true); offset += 8;
    const minY = view.getFloat64(offset, true); offset += 8;
    const minZ = view.getFloat64(offset, true); offset += 8;
    const maxX = view.getFloat64(offset, true); offset += 8;
    const maxY = view.getFloat64(offset, true); offset += 8;
    const maxZ = view.getFloat64(offset, true); offset += 8;
    const crsLen = view.getUint8(offset); offset += 1;
    const crs = new TextDecoder().decode(new Uint8Array(buf, offset, crsLen)) as DetectedCrs; offset += crsLen;

    const positions = new Float32Array(count * 3);
    positions.set(new Float32Array(buf.slice(offset, offset + count * 12))); offset += count * 12;
    const colors = new Uint8Array(buf, offset, count * 3); offset += count * 3;
    const classifications = new Uint8Array(buf, offset, count);

    return { positions, colors, classifications, count, bounds: { minX, minY, minZ, maxX, maxY, maxZ }, crs };
  } catch {
    return null;
  }
}

// --- Terrain mesh cache ---

function terrainKey(baseName: string): string {
  return baseName.replace(/\.copc\.laz$/, '.terrain_hd_v2');
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

// --- Normals cache ---

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
