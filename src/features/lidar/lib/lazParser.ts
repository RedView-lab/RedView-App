import type { PointCloudData, PointCloudBounds, DetectedCrs } from '../types';
import { detectCrs } from './coordConvert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lazPerfPromise: Promise<any> | null = null;

async function getLazPerf() {
  if (!lazPerfPromise) {
    lazPerfPromise = (async () => {
      const { Las } = await import('copc');
      return Las.PointData.createLazPerf({
        locateFile: () => '/laz-perf.wasm',
      });
    })();
  }
  return lazPerfPromise;
}

function makeGetter(ab: ArrayBuffer): (begin: number, end: number) => Promise<Uint8Array> {
  const view = new Uint8Array(ab);
  return async (begin: number, end: number) => view.subarray(begin, end);
}

export async function parseLazBuffer(
  buffer: ArrayBuffer,
  onProgress?: (phase: string, percent: number) => void,
  hintCrs?: DetectedCrs
): Promise<PointCloudData> {
  onProgress?.('Chargement du parser LAZ...', 0);

  const [{ Copc, Las }, lazPerf] = await Promise.all([
    import('copc'),
    getLazPerf(),
  ]);
  const fileBytes = new Uint8Array(buffer);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let view: any;
  let pointCount: number;

  // Try COPC first
  try {
    onProgress?.('Décompression COPC...', 10);
    const getter = makeGetter(buffer);
    const copc = await Copc.create(getter);
    const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);

    const allNodes = Object.values(nodes);
    if (allNodes.length === 0) throw new Error('No nodes in COPC hierarchy');

    const views: { v: any; count: number }[] = [];
    let loaded = 0;
    for (const node of allNodes) {
      const v = await Copc.loadPointDataView(getter, copc, node!, { lazPerf });
      views.push({ v, count: v.pointCount });
      loaded++;
      onProgress?.(`Lecture COPC ${loaded}/${allNodes.length}...`, 10 + (loaded / allNodes.length) * 50);
    }

    pointCount = views.reduce((s, v) => s + v.count, 0);
    const positions = new Float32Array(pointCount * 3);
    const classifications = new Uint8Array(pointCount);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let offset = 0;

    for (const { v, count } of views) {
      const getX = v.getter('X');
      const getY = v.getter('Y');
      const getZ = v.getter('Z');
      const getCls = v.getter('Classification');
      for (let i = 0; i < count; i++) {
        const x = getX(i);
        const y = getY(i);
        const z = getZ(i);
        const idx = (offset + i) * 3;
        positions[idx] = x;
        positions[idx + 1] = y;
        positions[idx + 2] = z;
        classifications[offset + i] = getCls(i);

        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      offset += count;
    }

    const bounds: PointCloudBounds = { minX, minY, minZ, maxX, maxY, maxZ };
    const crs = hintCrs ?? detectCrs(bounds.minY, bounds.maxY, bounds.minX, bounds.maxX);

    onProgress?.('Prêt', 100);
    return { positions, colors: new Uint8Array(pointCount * 3), classifications, count: pointCount, bounds, crs };
  } catch {
    // Not COPC — parse as regular LAZ/LAS
  }

  onProgress?.('Décompression LAZ...', 10);

  const header = Las.Header.parse(fileBytes);
  const rawPoints = await Las.PointData.decompressFile(fileBytes, lazPerf);
  view = Las.View.create(rawPoints, header);
  pointCount = view.pointCount;

  onProgress?.('Extraction des points...', 50);

  const positions = new Float32Array(pointCount * 3);
  const classifications = new Uint8Array(pointCount);

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getCls = view.getter('Classification');

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < pointCount; i++) {
    const x = getX(i);
    const y = getY(i);
    const z = getZ(i);
    const idx = i * 3;
    positions[idx] = x;
    positions[idx + 1] = y;
    positions[idx + 2] = z;
    classifications[i] = getCls(i);

    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const bounds: PointCloudBounds = { minX, minY, minZ, maxX, maxY, maxZ };
  const crs = hintCrs ?? detectCrs(bounds.minY, bounds.maxY, bounds.minX, bounds.maxX);

  onProgress?.('Prêt', 100);
  return { positions, colors: new Uint8Array(pointCount * 3), classifications, count: pointCount, bounds, crs };
}
