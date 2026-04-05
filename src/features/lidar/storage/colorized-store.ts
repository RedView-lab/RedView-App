import type { PointCloudData } from '../types/tile';
import type { DetectedCrs } from '../types/geometry';
import { getLidarDir } from './opfs-dir';

function colorizedKey(lazFileName: string): string {
  return lazFileName.replace(/\.copc\.laz$/, '').replace(/\.laz$/, '') + '.colorized';
}

export async function saveColorizedData(lazFileName: string, pc: PointCloudData): Promise<void> {
  const crsBytes = new TextEncoder().encode(pc.crs);
  const headerSize = 4 + 6 * 8 + 1 + crsBytes.byteLength;
  const dataSize = pc.count * 3 * 4 + pc.count * 3 + pc.count;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint32(offset, pc.count, true);
  offset += 4;

  const boundsValues = [
    pc.bounds.minX, pc.bounds.minY, pc.bounds.minZ,
    pc.bounds.maxX, pc.bounds.maxY, pc.bounds.maxZ,
  ];
  for (const v of boundsValues) {
    view.setFloat64(offset, v, true);
    offset += 8;
  }

  view.setUint8(offset, crsBytes.byteLength);
  offset += 1;

  new Uint8Array(buffer, offset, crsBytes.byteLength).set(crsBytes);
  offset += crsBytes.byteLength;

  new Float32Array(buffer, offset, pc.count * 3).set(pc.positions);
  offset += pc.count * 3 * 4;

  new Uint8Array(buffer, offset, pc.count * 3).set(pc.colors);
  offset += pc.count * 3;

  new Uint8Array(buffer, offset, pc.count).set(pc.classifications);

  const dir = await getLidarDir();
  const file = await dir.getFileHandle(colorizedKey(lazFileName), { create: true });
  const writable = await file.createWritable();
  await writable.write(buffer);
  await writable.close();
}

export async function loadColorizedData(lazFileName: string): Promise<PointCloudData | null> {
  try {
    const dir = await getLidarDir();
    const file = await dir.getFileHandle(colorizedKey(lazFileName));
    const blob = await file.getFile();
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    let offset = 0;

    const count = view.getUint32(offset, true);
    offset += 4;

    const bounds = {
      minX: view.getFloat64(offset, true),
      minY: view.getFloat64(offset + 8, true),
      minZ: view.getFloat64(offset + 16, true),
      maxX: view.getFloat64(offset + 24, true),
      maxY: view.getFloat64(offset + 32, true),
      maxZ: view.getFloat64(offset + 40, true),
    };
    offset += 48;

    const crsLen = view.getUint8(offset);
    offset += 1;

    const crsBytes = new Uint8Array(buffer, offset, crsLen);
    const crs = new TextDecoder().decode(crsBytes) as DetectedCrs;
    offset += crsLen;

    const positions = new Float32Array(buffer.slice(offset, offset + count * 3 * 4));
    offset += count * 3 * 4;

    const colors = new Uint8Array(buffer.slice(offset, offset + count * 3));
    offset += count * 3;

    const classifications = new Uint8Array(buffer.slice(offset, offset + count));

    return { positions, colors, classifications, count, bounds, crs };
  } catch {
    return null;
  }
}
