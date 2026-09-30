import type { PointCloudData, PointCloudBounds, DetectedCrs } from '../types';
import { detectCrs } from './coordConvert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lazPerfPromise: Promise<any> | null = null;
let lazPerfWithModule = false;

export async function getLazPerf(wasmModule?: WebAssembly.Module) {
  if (!lazPerfPromise || (wasmModule && !lazPerfWithModule)) {
    if (wasmModule) lazPerfWithModule = true;
    lazPerfPromise = (async () => {
      const { Las } = await import('copc');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: any = {
        locateFile: () => '/laz-perf.wasm',
      };
      if (wasmModule) {
        options.instantiateWasm = (
          info: WebAssembly.Imports,
          receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
        ) => {
          WebAssembly.instantiate(wasmModule, info)
            .then((instance) => receiveInstance(instance, wasmModule))
            .catch((err) => console.error('[laz-perf] instantiateWasm failed:', err));
          return {};
        };
      }
      return Las.PointData.createLazPerf(options);
    })();
  }
  return lazPerfPromise;
}

function makeGetter(ab: ArrayBuffer): (begin: number, end: number) => Promise<Uint8Array> {
  const view = new Uint8Array(ab);
  return async (begin: number, end: number) => view.subarray(begin, end);
}

export interface CopcDecodeHeader {
  pointDataRecordFormat: number;
  pointDataRecordLength: number;
  scale: readonly number[];
  offset: readonly number[];
}

export interface CopcChunk {
  pointCount: number;
  bytes: Uint8Array;
}

export interface DecodedCopcChunks {
  positions: Float32Array;
  classifications: Uint8Array;
  count: number;
  bounds: PointCloudBounds;
}

/** COPC mandates PDRF 6/7/8, which share the X/Y/Z/Classification layout. */
export function canFastDecodeCopc(header: { pointDataRecordFormat: number }): boolean {
  const format = header.pointDataRecordFormat & 0x3f;
  return format === 6 || format === 7 || format === 8;
}

/**
 * Decompresses COPC chunks and extracts only what the viewer needs
 * (X/Y/Z, Classification), reading each decoded record straight from the
 * laz-perf heap. Equivalent to `Copc.loadPointDataView` + per-point getters,
 * without the per-point Uint8Array/closure overhead.
 */
export function decodeCopcChunks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lazPerf: any,
  header: CopcDecodeHeader,
  chunks: CopcChunk[],
  onChunk?: (done: number, total: number) => void,
): DecodedCopcChunks {
  const count = chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0);
  const positions = new Float32Array(count * 3);
  const classifications = new Uint8Array(count);
  const { pointDataRecordFormat, pointDataRecordLength } = header;
  const [sx, sy, sz] = header.scale as [number, number, number];
  const [ox, oy, oz] = header.offset as [number, number, number];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let written = 0;

  const dataPointer: number = lazPerf._malloc(pointDataRecordLength);
  try {
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c]!;
      const blobPointer: number = lazPerf._malloc(chunk.bytes.byteLength);
      const decoder = new lazPerf.ChunkDecoder();
      try {
        (lazPerf.HEAPU8 as Uint8Array).set(chunk.bytes, blobPointer);
        decoder.open(pointDataRecordFormat, pointDataRecordLength, blobPointer);
        let heap = lazPerf.HEAPU8.buffer as ArrayBuffer;
        let dv = new DataView(heap);
        for (let i = 0; i < chunk.pointCount; i++) {
          decoder.getPoint(dataPointer);
          if (lazPerf.HEAPU8.buffer !== heap) {
            heap = lazPerf.HEAPU8.buffer as ArrayBuffer;
            dv = new DataView(heap);
          }
          const x = dv.getInt32(dataPointer, true) * sx + ox;
          const y = dv.getInt32(dataPointer + 4, true) * sy + oy;
          const z = dv.getInt32(dataPointer + 8, true) * sz + oz;
          const idx = written * 3;
          positions[idx] = x;
          positions[idx + 1] = y;
          positions[idx + 2] = z;
          classifications[written] = dv.getUint8(dataPointer + 16);
          written++;

          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      } finally {
        lazPerf._free(blobPointer);
        decoder.delete();
      }
      onChunk?.(c + 1, chunks.length);
    }
  } finally {
    lazPerf._free(dataPointer);
  }

  return { positions, classifications, count, bounds: { minX, minY, minZ, maxX, maxY, maxZ } };
}

/** Reads the COPC header + root hierarchy page and returns the chunk list. */
export async function readCopcLayout(buffer: ArrayBuffer): Promise<{
  header: CopcDecodeHeader & { min: number[]; max: number[] };
  nodes: { pointCount: number; pointDataOffset: number; pointDataLength: number }[];
}> {
  const { Copc } = await import('copc');
  const getter = makeGetter(buffer);
  const copc = await Copc.create(getter);
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const list = Object.values(nodes)
    .filter((node): node is NonNullable<typeof node> => !!node)
    .map((node) => ({
      pointCount: node.pointCount,
      pointDataOffset: node.pointDataOffset,
      pointDataLength: node.pointDataLength,
    }));
  const { pointDataRecordFormat, pointDataRecordLength, scale, offset, min, max } = copc.header;
  return {
    header: { pointDataRecordFormat, pointDataRecordLength, scale: [...scale], offset: [...offset], min: [...min], max: [...max] },
    nodes: list,
  };
}

export async function parseLazBuffer(
  buffer: ArrayBuffer,
  onProgress?: (phase: string, percent: number) => void,
  hintCrs?: DetectedCrs,
  wasmModule?: WebAssembly.Module,
): Promise<PointCloudData> {
  onProgress?.('Chargement du parser LAZ...', 0);

  const [{ Copc, Las }, lazPerf] = await Promise.all([
    import('copc'),
    getLazPerf(wasmModule),
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

    if (canFastDecodeCopc(copc.header)) {
      const fileView = new Uint8Array(buffer);
      const chunks: CopcChunk[] = allNodes.map((node) => ({
        pointCount: node!.pointCount,
        bytes: fileView.subarray(node!.pointDataOffset, node!.pointDataOffset + node!.pointDataLength),
      }));
      const decoded = decodeCopcChunks(lazPerf, copc.header, chunks, (done, total) => {
        onProgress?.(`Lecture COPC ${done}/${total}...`, 10 + (done / total) * 50);
      });
      const crs = hintCrs ?? detectCrs(decoded.bounds.minY, decoded.bounds.maxY, decoded.bounds.minX, decoded.bounds.maxX);
      onProgress?.('Prêt', 100);
      return {
        positions: decoded.positions,
        colors: new Uint8Array(decoded.count * 3),
        classifications: decoded.classifications,
        count: decoded.count,
        bounds: decoded.bounds,
        crs,
      };
    }

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
