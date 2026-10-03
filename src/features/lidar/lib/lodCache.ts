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
//
// Kept free of app imports so the cache worker stays small.

import type { DetectedCrs } from '../types';
import { LOD_POINT_STRIDE, type LodNode, type LodTile, type LodTileHeader } from '../viewer/lod/lodTile';

export const LIDAR_OPFS_DIR = 'lidar-hd';

const MAGIC = 0x314c5652; // "RVL1"
const VERSION = 1;
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

function decodeHeader(buffer: ArrayBuffer): { header: LodTileHeader; nodeCount: number } | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) return null;
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

function decodeNodes(buffer: ArrayBuffer, nodeCount: number): LodNode[] {
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
      byteOffset: view.getUint32(at + 20, true) * LOD_POINT_STRIDE,
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

/** Writes a tile; returns false when OPFS is unavailable or the write failed. */
export async function saveLodTile(lazFileName: string, tile: LodTile): Promise<boolean> {
  const dir = await getLidarDirectory();
  if (!dir) return false;
  const fileName = lodCacheKey(lazFileName);
  try {
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(encodeLodTileIndex(tile.header, tile.nodes) as Uint8Array<ArrayBuffer>);
      await writable.write(tile.packed as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
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
