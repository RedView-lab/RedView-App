import type { CachedTileInfo } from '../types/tile';
import type { TileCoord } from '../types/geometry';
import { buildTileFileName, parseTileFileName } from '../processing/coord-transform';
import { getLidarDir } from './opfs-dir';

function tileKey(coord: TileCoord): string {
  return `${buildTileFileName(coord)}.copc.laz`;
}

export async function saveTile(coord: TileCoord, data: ArrayBuffer): Promise<void> {
  const dir = await getLidarDir();
  const file = await dir.getFileHandle(tileKey(coord), { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function saveTileStream(
  coord: TileCoord,
  stream: ReadableStream<Uint8Array>,
  onProgress?: (bytesWritten: number) => void,
): Promise<void> {
  const dir = await getLidarDir();
  const file = await dir.getFileHandle(tileKey(coord), { create: true });
  const writable = await file.createWritable();
  const reader = stream.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value as BufferSource);
      written += value.byteLength;
      onProgress?.(written);
    }
  } finally {
    reader.releaseLock();
    await writable.close();
  }
}

export async function loadTile(coord: TileCoord): Promise<ArrayBuffer | null> {
  try {
    const dir = await getLidarDir();
    const file = await dir.getFileHandle(tileKey(coord));
    const blob = await file.getFile();
    return await blob.arrayBuffer();
  } catch {
    return null;
  }
}

export async function hasTile(coord: TileCoord): Promise<boolean> {
  try {
    const dir = await getLidarDir();
    await dir.getFileHandle(tileKey(coord));
    return true;
  } catch {
    return false;
  }
}

export async function deleteTile(coord: TileCoord): Promise<void> {
  try {
    const dir = await getLidarDir();
    await dir.removeEntry(tileKey(coord));
  } catch {
    // silent — file may not exist
  }
}

export async function listCachedTiles(): Promise<CachedTileInfo[]> {
  const dir = await getLidarDir();
  const results: CachedTileInfo[] = [];
  // @ts-expect-error -- OPFS entries() is available in modern browsers but not in TS strict lib
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const baseName = name.replace(/\.copc\.laz$/, '').replace(/\.laz$/, '');
    const coord = parseTileFileName(baseName);
    if (!coord) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    results.push({
      coord,
      fileName: name,
      sizeBytes: file.size,
      cachedAt: file.lastModified,
    });
  }
  return results;
}

export async function clearAllTiles(): Promise<void> {
  const dir = await getLidarDir();
  const names: string[] = [];
  // @ts-expect-error -- OPFS entries() is available in modern browsers but not in TS strict lib
  for await (const [name] of dir.entries()) {
    names.push(name);
  }
  for (const name of names) {
    await dir.removeEntry(name);
  }
}
