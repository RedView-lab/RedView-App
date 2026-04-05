import { getLidarDir } from './opfs-dir';

function normalsKey(lazFileName: string): string {
  return lazFileName.replace(/\.copc\.laz$/, '').replace(/\.laz$/, '') + '.normals';
}

export async function saveNormalsData(lazFileName: string, normals: Float32Array): Promise<void> {
  const dir = await getLidarDir();
  const file = await dir.getFileHandle(normalsKey(lazFileName), { create: true });
  const writable = await file.createWritable();
  await writable.write(new Uint8Array(normals.buffer) as unknown as BufferSource);
  await writable.close();
}

export async function loadNormalsData(
  lazFileName: string,
  expectedCount: number,
): Promise<Float32Array | null> {
  try {
    const dir = await getLidarDir();
    const file = await dir.getFileHandle(normalsKey(lazFileName));
    const blob = await file.getFile();
    const buffer = await blob.arrayBuffer();
    const normals = new Float32Array(buffer);
    if (normals.length !== expectedCount * 3) return null;
    return normals;
  } catch {
    return null;
  }
}
