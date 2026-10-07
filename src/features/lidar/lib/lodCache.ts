// ============================================
// LiDAR LOD cache (OPFS): one file per tile, nodes readable one by one
// ============================================
//
// Layout (little-endian):
//   header (160 B): magic "RVL1", version, pointCount, nodeCount,
//     bounds 6×f64, origin 3×f64, cube min 3×f64 + size f64, root spacing f64,
//     flags u8 (bit 0 = embedded RGB), crs length u8 + crs bytes
//   node table: nodeCount × 24 B (depth, x, y, z, count, first point index; u32)
//   point data (16-byte aligned): node blocks of LOD_POINT_STRIDE bytes/point
// Opening a cached tile reads only the header and the table; the viewer then
// streams node blocks with `File.slice()` as the LOD asks for them.
// Version 1 stored 12-byte points without the filtered attributes; such a
// file is upgraded instead of rebuilt (`upgradeLegacyLodTile`): no LAZ
// decoding, no orthophoto download.
//
// Kept free of app imports so the cache worker stays small.

import type { DetectedCrs } from '../types';
import {
  filterLodAttributes,
  LOD_POINT_STRIDE,
  type LodNode,
  type LodTile,
  type LodTileHeader,
} from '../viewer/lod/lodTile';

export const LIDAR_OPFS_DIR = 'lidar-hd';

const MAGIC = 0x314c5652; // "RVL1"
const VERSION = 2;
const LEGACY_VERSION = 1;
/** Point record of version 1: position, class, intensity, RGB, padding. */
const LEGACY_POINT_STRIDE = 12;
const HEADER_BYTES = 160;
const NODE_ENTRY_BYTES = 24;
const MAX_CRS_BYTES = HEADER_BYTES - 130;

// The LOD and terrain caches bake the ortho colours in. When a territory's
// imagery source changes, its revision suffix changes so those tiles are
// recoloured from the cached LAZ; the previous keys are listed as legacy.
// NZ `_c2`: Esri "Map data not yet available" placeholders no longer used.
const COLOUR_REVISIONS: ReadonlyArray<{ match: RegExp; suffix: string }> = [
  { match: /_PTS_NZTM2000_/, suffix: '_c2' },
];

export function colourRevisionSuffix(lazFileName: string): string {
  return COLOUR_REVISIONS.find(({ match }) => match.test(lazFileName))?.suffix ?? '';
}

export function lodCacheKey(lazFileName: string): string {
  return lazFileName.replace(/(\.copc)?\.laz$/, `.lod_v2${colourRevisionSuffix(lazFileName)}`);
}

/** Version 1 cache of the same tile and colours (see `upgradeLegacyLodTile`). */
export function legacyLodCacheKey(lazFileName: string): string {
  return lazFileName.replace(/(\.copc)?\.laz$/, `.lod_v1${colourRevisionSuffix(lazFileName)}`);
}

export interface OpenedLodTile {
  header: LodTileHeader;
  nodes: LodNode[];
  /** Byte offset of the point data in the file. */
  dataOffset: number;
  file: File;
}

function align16(value: number): number {
  return Math.ceil(value / 16) * 16;
}

/** Header + node table, padded so the point data starts 16-byte aligned. */
export function encodeLodTileIndex(header: LodTileHeader, nodes: LodNode[]): Uint8Array {
  const crsBytes = new TextEncoder().encode(header.crs);
  if (crsBytes.length > MAX_CRS_BYTES) throw new Error(`CRS name too long for the LOD cache: ${header.crs}`);
  const indexBytes = align16(HEADER_BYTES + nodes.length * NODE_ENTRY_BYTES);
  const out = new Uint8Array(indexBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, header.pointCount, true);
  view.setUint32(12, nodes.length, true);
  const b = header.bounds;
  [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].forEach((value, i) => view.setFloat64(16 + i * 8, value, true));
  view.setFloat64(64, header.origin.x, true);
  view.setFloat64(72, header.origin.y, true);
  view.setFloat64(80, header.origin.z, true);
  view.setFloat64(88, header.cubeMinX, true);
  view.setFloat64(96, header.cubeMinY, true);
  view.setFloat64(104, header.cubeMinZ, true);
  view.setFloat64(112, header.cubeSize, true);
  view.setFloat64(120, header.rootSpacing, true);
  view.setUint8(128, header.embeddedRgb ? 1 : 0);
  view.setUint8(129, crsBytes.length);
  out.set(crsBytes, 130);
  nodes.forEach((node, i) => {
    const at = HEADER_BYTES + i * NODE_ENTRY_BYTES;
    view.setUint32(at, node.depth, true);
    view.setUint32(at + 4, node.x, true);
    view.setUint32(at + 8, node.y, true);
    view.setUint32(at + 12, node.z, true);
    view.setUint32(at + 16, node.count, true);
    view.setUint32(at + 20, node.byteOffset / LOD_POINT_STRIDE, true);
  });
  return out;
}

function decodeHeader(buffer: ArrayBuffer, version = VERSION): { header: LodTileHeader; nodeCount: number } | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== version) return null;
  const crsLength = view.getUint8(129);
  if (crsLength > MAX_CRS_BYTES) return null;
  const f = (at: number) => view.getFloat64(at, true);
  const nodeCount = view.getUint32(12, true);
  return {
    nodeCount,
    header: {
      pointCount: view.getUint32(8, true),
      nodeCount,
      bounds: { minX: f(16), minY: f(24), minZ: f(32), maxX: f(40), maxY: f(48), maxZ: f(56) },
      origin: { x: f(64), y: f(72), z: f(80) },
      cubeMinX: f(88),
      cubeMinY: f(96),
      cubeMinZ: f(104),
      cubeSize: f(112),
      rootSpacing: f(120),
      embeddedRgb: (view.getUint8(128) & 1) === 1,
      crs: new TextDecoder().decode(new Uint8Array(buffer, 130, crsLength)) as DetectedCrs,
    },
  };
}

function decodeNodes(buffer: ArrayBuffer, nodeCount: number, pointStride = LOD_POINT_STRIDE): LodNode[] {
  const view = new DataView(buffer);
  const nodes: LodNode[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const at = i * NODE_ENTRY_BYTES;
    nodes[i] = {
      depth: view.getUint32(at, true),
      x: view.getUint32(at + 4, true),
      y: view.getUint32(at + 8, true),
      z: view.getUint32(at + 12, true),
      count: view.getUint32(at + 16, true),
      byteOffset: view.getUint32(at + 20, true) * pointStride,
    };
  }
  return nodes;
}

async function getLidarDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(LIDAR_OPFS_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Sync access handle of OPFS, exposed in dedicated workers only. */
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

/**
 * Writes `parts` back to back. In a worker (where the LOD cache is built) a
 * sync access handle writes in place: `createWritable` writes a swap file
 * that `close()` then moves into place, ~2× the time for a 375 MB tile.
 */
async function writeOpfsFile(handle: FileSystemFileHandle, parts: Uint8Array[]): Promise<void> {
  const openSync = (handle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }).createSyncAccessHandle;
  if (typeof openSync === 'function') {
    const access = await openSync.call(handle);
    try {
      access.truncate(0);
      let at = 0;
      for (const part of parts) {
        const written = access.write(part, { at });
        if (written !== part.byteLength) throw new Error(`Short OPFS write: ${written}/${part.byteLength} bytes`);
        at += written;
      }
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable();
  try {
    for (const part of parts) await writable.write(part as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/** Writes a tile; returns false when OPFS is unavailable or the write failed. */
export async function saveLodTile(lazFileName: string, tile: LodTile): Promise<boolean> {
  const dir = await getLidarDirectory();
  if (!dir) return false;
  const fileName = lodCacheKey(lazFileName);
  try {
    const handle = await dir.getFileHandle(fileName, { create: true });
    await writeOpfsFile(handle, [encodeLodTileIndex(tile.header, tile.nodes), tile.packed]);
    return true;
  } catch (error) {
    console.warn(`[LiDAR LOD cache] Failed to write ${fileName}:`, error);
    try {
      await dir.removeEntry(fileName);
    } catch {
      /* nothing to clean */
    }
    return false;
  }
}

/** Opens a cached tile (header + node table only), or null when absent/invalid. */
export async function openLodTile(lazFileName: string): Promise<OpenedLodTile | null> {
  const dir = await getLidarDirectory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(lodCacheKey(lazFileName));
    const file = await handle.getFile();
    const decoded = decodeHeader(await file.slice(0, HEADER_BYTES).arrayBuffer());
    if (!decoded) return null;
    const tableEnd = HEADER_BYTES + decoded.nodeCount * NODE_ENTRY_BYTES;
    const dataOffset = align16(tableEnd);
    const nodes = decodeNodes(await file.slice(HEADER_BYTES, tableEnd).arrayBuffer(), decoded.nodeCount);
    const last = nodes[nodes.length - 1];
    const expectedSize = dataOffset + decoded.header.pointCount * LOD_POINT_STRIDE;
    if (file.size < expectedSize || (last && dataOffset + last.byteOffset + last.count * LOD_POINT_STRIDE > file.size)) {
      return null;
    }
    return { header: decoded.header, nodes, dataOffset, file };
  } catch {
    return null;
  }
}

/**
 * Rewrites a version 1 cache of `lazFileName` as version 2: records widened
 * to 16 bytes, filtered attributes computed, then the old file removed.
 * Node blocks are read one by one, so only the new tile is held in memory.
 * Resolves to false when there is no usable version 1 file (or OPFS fails).
 */
export async function upgradeLegacyLodTile(lazFileName: string): Promise<boolean> {
  const dir = await getLidarDirectory();
  if (!dir) return false;
  const legacyName = legacyLodCacheKey(lazFileName);
  let file: File;
  try {
    file = await (await dir.getFileHandle(legacyName)).getFile();
  } catch {
    return false;
  }
  const decoded = decodeHeader(await file.slice(0, HEADER_BYTES).arrayBuffer(), LEGACY_VERSION);
  if (!decoded) return false;
  const tableEnd = HEADER_BYTES + decoded.nodeCount * NODE_ENTRY_BYTES;
  const dataOffset = align16(tableEnd);
  const legacyNodes = decodeNodes(await file.slice(HEADER_BYTES, tableEnd).arrayBuffer(), decoded.nodeCount, LEGACY_POINT_STRIDE);
  const pointCount = decoded.header.pointCount;
  if (file.size < dataOffset + pointCount * LEGACY_POINT_STRIDE) return false;

  const packed = new Uint8Array(pointCount * LOD_POINT_STRIDE);
  const nodes: LodNode[] = [];
  let written = 0;
  for (const legacy of legacyNodes) {
    const start = dataOffset + legacy.byteOffset;
    const block = new Uint8Array(await file.slice(start, start + legacy.count * LEGACY_POINT_STRIDE).arrayBuffer());
    if (block.byteLength < legacy.count * LEGACY_POINT_STRIDE) return false;
    const byteOffset = written * LOD_POINT_STRIDE;
    for (let k = 0; k < legacy.count; k++) {
      const src = k * LEGACY_POINT_STRIDE;
      const dst = byteOffset + k * LOD_POINT_STRIDE;
      packed.set(block.subarray(src, src + 11), dst);
      // Filtered copies; the cell means of nodes with children replace them below.
      packed[dst + 11] = block[src + 7]!;
      packed[dst + 12] = block[src + 8]!;
      packed[dst + 13] = block[src + 9]!;
      packed[dst + 14] = block[src + 10]!;
    }
    nodes.push({ ...legacy, byteOffset });
    written += legacy.count;
  }
  if (written !== pointCount) return false;
  const tile: LodTile = { header: { ...decoded.header, nodeCount: nodes.length }, nodes, packed };
  filterLodAttributes(tile);
  if (!(await saveLodTile(lazFileName, tile))) return false;
  try {
    await dir.removeEntry(legacyName);
  } catch {
    /* already gone */
  }
  return true;
}

export async function readLodNodeBlock(tile: OpenedLodTile, node: LodNode): Promise<ArrayBuffer> {
  const start = tile.dataOffset + node.byteOffset;
  return tile.file.slice(start, start + node.count * LOD_POINT_STRIDE).arrayBuffer();
}

/** In-memory twin of `OpenedLodTile` when OPFS cannot store the tile. */
export function createInMemoryLodTile(tile: LodTile): OpenedLodTile {
  const index = encodeLodTileIndex(tile.header, tile.nodes);
  const blob = new Blob([index as Uint8Array<ArrayBuffer>, tile.packed as Uint8Array<ArrayBuffer>]);
  return {
    header: tile.header,
    nodes: tile.nodes,
    dataOffset: index.byteLength,
    file: new File([blob], 'lod-memory.bin'),
  };
}
