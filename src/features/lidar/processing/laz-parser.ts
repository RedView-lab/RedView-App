import type { PointCloudData } from '../types/tile';
import type { DetectedCrs, PointCloudBounds } from '../types/geometry';
import { detectCrs } from '../processing/coord-transform';

// Singleton lazPerf WASM instance — initialized once per thread (main or worker)
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

/**
 * Create a copc-compatible Getter from an ArrayBuffer.
 * Getter signature: (begin: number, end: number) => Promise<Uint8Array>
 */
function bufferGetter(buf: ArrayBuffer): (begin: number, end: number) => Promise<Uint8Array> {
  const bytes = new Uint8Array(buf);
  return async (begin: number, end: number) => bytes.slice(begin, end);
}

function extractPoints(
  view: { pointCount: number; getter: (name: string) => (index: number) => number },
): { positions: Float32Array; colors: Uint8Array; classifications: Uint8Array; count: number } {
  const n = view.pointCount;
  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = view.getter('Red');
  const getG = view.getter('Green');
  const getB = view.getter('Blue');
  const getCls = view.getter('Classification');

  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  const classifications = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    positions[i * 3] = getX(i);
    positions[i * 3 + 1] = getY(i);
    positions[i * 3 + 2] = getZ(i);
    colors[i * 3] = Math.min(255, getR(i) >> 8);
    colors[i * 3 + 1] = Math.min(255, getG(i) >> 8);
    colors[i * 3 + 2] = Math.min(255, getB(i) >> 8);
    classifications[i] = getCls(i);
  }

  return { positions, colors, classifications, count: n };
}

export async function parseLazFile(buffer: ArrayBuffer): Promise<PointCloudData> {
  const { Copc, Las } = await import('copc');
  const lazPerf = await getLazPerf();
  const getter = bufferGetter(buffer);

  let positions: Float32Array;
  let colors: Uint8Array;
  let classifications: Uint8Array;
  let count: number;
  let bounds: PointCloudBounds;
  let crs: DetectedCrs;

  try {
    // Try COPC first (LiDAR HD files are typically COPC)
    const copc = await Copc.create(getter);

    // Load root hierarchy page to discover nodes
    const hierarchy = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
    const nodeEntries = Object.entries(hierarchy.nodes);
    if (nodeEntries.length === 0) throw new Error('Empty COPC hierarchy');

    const chunks: Array<ReturnType<typeof extractPoints>> = [];
    let totalCount = 0;

    for (const [, node] of nodeEntries) {
      if (!node || node.pointCount === 0) continue;
      const view = await Copc.loadPointDataView(getter, copc, node, { lazPerf });
      const chunk = extractPoints(view);
      chunks.push(chunk);
      totalCount += chunk.count;
    }

    count = totalCount;
    positions = new Float32Array(count * 3);
    colors = new Uint8Array(count * 3);
    classifications = new Uint8Array(count);

    let offset = 0;
    for (const chunk of chunks) {
      positions.set(chunk.positions, offset * 3);
      colors.set(chunk.colors, offset * 3);
      classifications.set(chunk.classifications, offset);
      offset += chunk.count;
    }

    const header = copc.header;
    bounds = {
      minX: header.min[0], minY: header.min[1], minZ: header.min[2],
      maxX: header.max[0], maxY: header.max[1], maxZ: header.max[2],
    };

    const yMean = (bounds.minY + bounds.maxY) / 2;
    crs = detectCrs(yMean);
  } catch (copcErr) {
    // Fallback: standard LAS/LAZ (non-COPC)
    console.warn('[lidar] COPC parsing failed, trying standard LAS/LAZ fallback:', copcErr);
    try {
    const lazBuf = new Uint8Array(buffer);
    const decompressed = await Las.PointData.decompressFile(lazBuf, lazPerf);
    const header = Las.Header.parse(decompressed);

    // Build a view from the decompressed data
    const pointDataBuf = decompressed.slice(header.pointDataOffset);
    const view = Las.View.create(pointDataBuf, header);

    count = view.pointCount;
    const extracted = extractPoints(view);
    positions = extracted.positions;
    colors = extracted.colors;
    classifications = extracted.classifications;

    bounds = {
      minX: header.min[0], minY: header.min[1], minZ: header.min[2],
      maxX: header.max[0], maxY: header.max[1], maxZ: header.max[2],
    };

    const yMean = (bounds.minY + bounds.maxY) / 2;
    crs = detectCrs(yMean);
    } catch (lasErr) {
      throw new Error(
        `Failed to parse LAZ file. COPC error: ${copcErr instanceof Error ? copcErr.message : copcErr}; ` +
        `LAS fallback error: ${lasErr instanceof Error ? lasErr.message : lasErr}`
      );
    }
  }

  return { positions, colors, classifications, count, bounds, crs };
}
