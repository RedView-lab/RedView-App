import type { PointCloudData, PointCloudBounds } from './types';
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
  return async (begin: number, end: number) => view.slice(begin, end);
}

export async function parseLazBuffer(
  buffer: ArrayBuffer,
  onProgress?: (phase: string, percent: number) => void
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
    let offset = 0;

    for (const { v, count } of views) {
      const getX = v.getter('X');
      const getY = v.getter('Y');
      const getZ = v.getter('Z');
      const getCls = v.getter('Classification');
      for (let i = 0; i < count; i++) {
        positions[(offset + i) * 3] = getX(i);
        positions[(offset + i) * 3 + 1] = getY(i);
        positions[(offset + i) * 3 + 2] = getZ(i);
        classifications[offset + i] = getCls(i);
      }
      offset += count;
    }

    onProgress?.('Calcul des bornes...', 80);
    const bounds = computeBounds(positions, pointCount);
    const crs = detectCrs(bounds.minY, bounds.maxY);

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

  for (let i = 0; i < pointCount; i++) {
    positions[i * 3] = getX(i);
    positions[i * 3 + 1] = getY(i);
    positions[i * 3 + 2] = getZ(i);
    classifications[i] = getCls(i);
  }

  onProgress?.('Calcul des bornes...', 80);
  const bounds = computeBounds(positions, pointCount);
  const crs = detectCrs(bounds.minY, bounds.maxY);

  onProgress?.('Prêt', 100);
  return { positions, colors: new Uint8Array(pointCount * 3), classifications, count: pointCount, bounds, crs };
}

function computeBounds(positions: Float32Array, count: number): PointCloudBounds {
  const bounds: PointCloudBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }
  return bounds;
}
