import type { TileCoord, CachedTileInfo, PointCloudData, DetectedCrs } from './types';
import { buildTileFileName } from './coordConvert';

const LIDAR_DIR = 'lidar-hd';

async function getLidarDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(LIDAR_DIR, { create: true });
}

function tileKey(coord: TileCoord): string {
  return `${buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef)}.copc.laz`;
}

export async function saveTile(coord: TileCoord, data: ArrayBuffer): Promise<void> {
  const dir = await getLidarDir();
  const fileName = tileKey(coord);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function loadTile(coord: TileCoord): Promise<ArrayBuffer | null> {
  try {
    const dir = await getLidarDir();
    const fileName = tileKey(coord);
    const fileHandle = await dir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function hasTile(coord: TileCoord): Promise<boolean> {
  try {
    const dir = await getLidarDir();
    const fileName = tileKey(coord);
    await dir.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}

export async function deleteTile(coord: TileCoord): Promise<void> {
  try {
    const dir = await getLidarDir();
    const fileName = tileKey(coord);
    await dir.removeEntry(fileName);
  } catch {
    // File already deleted or doesn't exist
  }
}

export async function listCachedTiles(): Promise<CachedTileInfo[]> {
  const dir = await getLidarDir();
  const tiles: CachedTileInfo[] = [];

  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind !== 'file') continue;
    if (!name.endsWith('.laz')) continue;

    const file = await (handle as FileSystemFileHandle).getFile();

    const match = name.match(/^LHD_(\w+)_(\d{4})_(\d{4})_PTS_(\w+)_(\w+)\.copc\.laz$/);
    if (!match) continue;

    const [, territory, xStr, yStr, projection, altRef] = match;
    tiles.push({
      coord: {
        xKm: parseInt(xStr, 10),
        yKm: parseInt(yStr, 10),
        territory: territory as any,
        projection: projection as any,
        altRef: altRef as any,
      },
      fileName: name,
      sizeBytes: file.size,
      cachedAt: file.lastModified,
    });
  }

  return tiles;
}

export async function getStorageUsage(): Promise<{ used: number; quota: number }> {
  const estimate = await navigator.storage.estimate();
  return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

export async function clearAllTiles(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(LIDAR_DIR, { recursive: true });
  } catch {
    // Directory doesn't exist
  }
}

// --- Colorized point cloud cache ---

function colorizedKey(baseName: string): string {
  return baseName.replace(/\.copc\.laz$/, '.colorized');
}

export async function saveColorizedData(lazFileName: string, pc: PointCloudData): Promise<void> {
  const dir = await getLidarDir();
  const fileName = colorizedKey(lazFileName);
  const crsBytes = new TextEncoder().encode(pc.crs);

  const headerSize = 4 + 48 + 1 + crsBytes.length;
  const posBytes = pc.count * 12;
  const colBytes = pc.count * 3;
  const clsBytes = pc.count;
  const totalSize = headerSize + posBytes + colBytes + clsBytes;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  let offset = 0;

  view.setUint32(offset, pc.count, true); offset += 4;
  view.setFloat64(offset, pc.bounds.minX, true); offset += 8;
  view.setFloat64(offset, pc.bounds.minY, true); offset += 8;
  view.setFloat64(offset, pc.bounds.minZ, true); offset += 8;
  view.setFloat64(offset, pc.bounds.maxX, true); offset += 8;
  view.setFloat64(offset, pc.bounds.maxY, true); offset += 8;
  view.setFloat64(offset, pc.bounds.maxZ, true); offset += 8;
  view.setUint8(offset, crsBytes.length); offset += 1;
  new Uint8Array(buf, offset, crsBytes.length).set(crsBytes); offset += crsBytes.length;
  new Uint8Array(buf, offset, posBytes).set(new Uint8Array(pc.positions.buffer, pc.positions.byteOffset, posBytes)); offset += posBytes;
  new Uint8Array(buf, offset, colBytes).set(pc.colors.subarray(0, colBytes)); offset += colBytes;
  new Uint8Array(buf, offset, clsBytes).set(pc.classifications.subarray(0, clsBytes));

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(buf);
  await writable.close();
}

export async function loadColorizedData(lazFileName: string): Promise<PointCloudData | null> {
  try {
    const dir = await getLidarDir();
    const fileName = colorizedKey(lazFileName);
    const fileHandle = await dir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
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
  return baseName.replace(/\.copc\.laz$/, '.terrain');
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
  const fileName = terrainKey(lazFileName);
  const headerSize = 16;
  const vertBytes = mesh.vertexCount * 24;
  const colBytes = mesh.vertexCount * 4;
  const idxBytes = mesh.indexCount * 4;
  const hmBytes = mesh.gridWidth * mesh.gridHeight * 4;
  const buf = new ArrayBuffer(headerSize + vertBytes + colBytes + idxBytes + hmBytes);
  const view = new DataView(buf);
  view.setUint32(0, mesh.vertexCount, true);
  view.setUint32(4, mesh.indexCount, true);
  view.setUint32(8, mesh.gridWidth, true);
  view.setUint32(12, mesh.gridHeight, true);
  let off = headerSize;
  new Uint8Array(buf, off, vertBytes).set(new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, vertBytes)); off += vertBytes;
  new Uint8Array(buf, off, colBytes).set(mesh.colors.subarray(0, colBytes)); off += colBytes;
  new Uint8Array(buf, off, idxBytes).set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, idxBytes)); off += idxBytes;
  new Uint8Array(buf, off, hmBytes).set(new Uint8Array(mesh.heightGrid.buffer, mesh.heightGrid.byteOffset, hmBytes));

  const fh = await dir.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
}

export async function loadTerrainData(lazFileName: string): Promise<TerrainCache | null> {
  try {
    const dir = await getLidarDir();
    const fh = await dir.getFileHandle(terrainKey(lazFileName));
    const buf = await (await fh.getFile()).arrayBuffer();
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
  const fh = await dir.getFileHandle(normalsKey(lazFileName), { create: true });
  const w = await fh.createWritable();
  await w.write(normals.buffer);
  await w.close();
}

export async function loadNormalsData(lazFileName: string, expectedCount: number): Promise<Float32Array | null> {
  try {
    const dir = await getLidarDir();
    const fh = await dir.getFileHandle(normalsKey(lazFileName));
    const buf = await (await fh.getFile()).arrayBuffer();
    const normals = new Float32Array(buf);
    if (normals.length !== expectedCount * 3) return null;
    return normals;
  } catch {
    return null;
  }
}
