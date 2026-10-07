import type { Getter, Hierarchy } from 'copc';
import type { CopcHierarchyInfo, PointCloudData, PointCloudBounds, PointCloudOrigin, DetectedCrs } from '../types';
import { detectCrs } from './coordConvert';
import { decodeCopcChunksWithRedviewLaz, initRedviewLaz } from './laz/redviewLaz';

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

function makeGetter(ab: ArrayBuffer): Getter {
  const view = new Uint8Array(ab);
  return async (begin: number, end: number) => view.subarray(begin, end);
}

/**
 * Km-aligned origin for the float32 positions. Snapping to whole kilometres
 * keeps origins of neighbouring tiles exact multiples of 1000 m, so re-basing
 * tiles onto a shared scene origin is lossless.
 */
export function computeLocalOrigin(min: readonly number[]): PointCloudOrigin {
  const snap = (value: number | undefined) => (
    value !== undefined && Number.isFinite(value) ? Math.floor(value / 1000) * 1000 : 0
  );
  return { x: snap(min[0]), y: snap(min[1]), z: 0 };
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

export interface CopcNodeEntry {
  /** COPC octree key "D-X-Y-Z". */
  key: string;
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
}

export interface DecodedCopcChunks {
  positions: Float32Array;
  classifications: Uint8Array;
  intensities: Uint16Array;
  /** High bytes of the embedded 16-bit RGB (PDRF 7/8), or null when the format has no colour. */
  colors: Uint8Array | null;
  /** Largest raw 16-bit RGB channel value seen (0 without colour), see `hasUsableEmbeddedRgb`. */
  maxRgb: number;
  count: number;
  bounds: PointCloudBounds;
}

/** COPC mandates PDRF 6/7/8, which share the X/Y/Z/Classification layout. */
export function canFastDecodeCopc(header: { pointDataRecordFormat: number }): boolean {
  const format = header.pointDataRecordFormat & 0x3f;
  return format === 6 || format === 7 || format === 8;
}

/** PDRF 7/8 store Red/Green/Blue as u16 at byte 30 (after the f64 GPS time). */
function copcRgbOffset(pointDataRecordFormat: number): number | null {
  const format = pointDataRecordFormat & 0x3f;
  return format === 7 || format === 8 ? 30 : null;
}

/**
 * Embedded colour is used only when it is 16-bit scaled as the LAS spec
 * requires (some channel above 255): all-zero RGB means "not colourised",
 * and 8-bit-scaled values would have been truncated by the `>> 8` decode.
 */
export function hasUsableEmbeddedRgb(maxRgb: number): boolean {
  return maxRgb > 255;
}

function compareCopcKeys(a: string, b: string): number {
  const pa = a.split('-');
  const pb = b.split('-');
  for (let i = 0; i < 4; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Walks every hierarchy page (a COPC hierarchy may be split into child pages,
 * which the root page only references) and returns the non-empty nodes,
 * coarse levels first.
 */
async function loadCopcNodes(getter: Getter, rootPage: Hierarchy.Page): Promise<CopcNodeEntry[]> {
  const { Copc } = await import('copc');
  const entries: CopcNodeEntry[] = [];
  const pages: Hierarchy.Page[] = [rootPage];
  for (let i = 0; i < pages.length; i++) {
    const subtree = await Copc.loadHierarchyPage(getter, pages[i]!);
    for (const [key, node] of Object.entries(subtree.nodes)) {
      if (!node || node.pointCount <= 0) continue;
      entries.push({
        key,
        pointCount: node.pointCount,
        pointDataOffset: node.pointDataOffset,
        pointDataLength: node.pointDataLength,
      });
    }
    for (const page of Object.values(subtree.pages)) {
      if (page) pages.push(page);
    }
  }
  entries.sort((a, b) => compareCopcKeys(a.key, b.key));
  return entries;
}

/**
 * Decompresses COPC chunks and extracts only what the viewer needs
 * (X/Y/Z relative to `origin`, Classification), reading each decoded record
 * straight from the laz-perf heap. Equivalent to `Copc.loadPointDataView` +
 * per-point getters, without the per-point Uint8Array/closure overhead.
 */
export function decodeCopcChunks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lazPerf: any,
  header: CopcDecodeHeader,
  chunks: CopcChunk[],
  origin: PointCloudOrigin,
  onChunk?: (done: number, total: number) => void,
): DecodedCopcChunks {
  const count = chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0);
  const positions = new Float32Array(count * 3);
  const classifications = new Uint8Array(count);
  const intensities = new Uint16Array(count);
  const { pointDataRecordFormat, pointDataRecordLength } = header;
  const rgbOffset = copcRgbOffset(pointDataRecordFormat);
  const colors = rgbOffset !== null ? new Uint8Array(count * 3) : null;
  let maxRgb = 0;
  const [sx, sy, sz] = header.scale as [number, number, number];
  const [ox, oy, oz] = header.offset as [number, number, number];
  // Offsets relative to the local origin (float64): x_local = X * sx + lox.
  const lox = ox - origin.x;
  const loy = oy - origin.y;
  const loz = oz - origin.z;
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
          const x = dv.getInt32(dataPointer, true) * sx + lox;
          const y = dv.getInt32(dataPointer + 4, true) * sy + loy;
          const z = dv.getInt32(dataPointer + 8, true) * sz + loz;
          const idx = written * 3;
          positions[idx] = x;
          positions[idx + 1] = y;
          positions[idx + 2] = z;
          classifications[written] = dv.getUint8(dataPointer + 16);
          intensities[written] = dv.getUint16(dataPointer + 12, true);
          if (colors !== null) {
            const r = dv.getUint16(dataPointer + rgbOffset!, true);
            const g = dv.getUint16(dataPointer + rgbOffset! + 2, true);
            const b = dv.getUint16(dataPointer + rgbOffset! + 4, true);
            colors[idx] = r >> 8;
            colors[idx + 1] = g >> 8;
            colors[idx + 2] = b >> 8;
            if (r > maxRgb) maxRgb = r;
            if (g > maxRgb) maxRgb = g;
            if (b > maxRgb) maxRgb = b;
          }
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

  return {
    positions,
    classifications,
    intensities,
    colors,
    maxRgb,
    count,
    bounds: {
      minX: minX + origin.x, minY: minY + origin.y, minZ: minZ + origin.z,
      maxX: maxX + origin.x, maxY: maxY + origin.y, maxZ: maxZ + origin.z,
    },
  };
}

/** Reads the COPC header + full hierarchy and returns the chunk list (coarse levels first). */
export async function readCopcLayout(buffer: ArrayBuffer): Promise<{
  header: CopcDecodeHeader & { min: number[]; max: number[] };
  nodes: CopcNodeEntry[];
  cube: number[];
  spacing: number;
}> {
  const { Copc } = await import('copc');
  const getter = makeGetter(buffer);
  const copc = await Copc.create(getter);
  const nodes = await loadCopcNodes(getter, copc.info.rootHierarchyPage);
  const { pointDataRecordFormat, pointDataRecordLength, scale, offset, min, max } = copc.header;
  return {
    header: { pointDataRecordFormat, pointDataRecordLength, scale: [...scale], offset: [...offset], min: [...min], max: [...max] },
    nodes,
    cube: [...copc.info.cube],
    spacing: copc.info.spacing,
  };
}

/** Hierarchy summary handed to the viewer with the decoded points. */
export function toCopcHierarchyInfo(nodes: CopcNodeEntry[], cube: readonly number[], spacing: number): CopcHierarchyInfo {
  return {
    nodes: nodes.map((node) => ({ key: node.key, pointCount: node.pointCount })),
    cube: [...cube],
    spacing,
  };
}

export async function parseLazBuffer(
  buffer: ArrayBuffer,
  onProgress?: (phase: string, percent: number) => void,
  hintCrs?: DetectedCrs,
  wasmModule?: WebAssembly.Module,
  /** RedView LAZ decoder (lib/laz/) for COPC files; laz-perf without it or if it fails. */
  redviewLazModule?: WebAssembly.Module | null,
): Promise<PointCloudData> {
  onProgress?.('Chargement du parser LAZ...', 0);

  const [{ Copc, Las }, lazPerf] = await Promise.all([
    import('copc'),
    getLazPerf(wasmModule),
  ]);
  const fileBytes = new Uint8Array(buffer);

  // Try COPC first
  try {
    onProgress?.('Décompression COPC...', 10);
    const getter = makeGetter(buffer);
    const copc = await Copc.create(getter);
    const allNodes = await loadCopcNodes(getter, copc.info.rootHierarchyPage);
    if (allNodes.length === 0) throw new Error('No nodes in COPC hierarchy');
    const origin = computeLocalOrigin(copc.header.min);

    if (canFastDecodeCopc(copc.header)) {
      const fileView = new Uint8Array(buffer);
      const chunks: CopcChunk[] = allNodes.map((node) => ({
        pointCount: node.pointCount,
        bytes: fileView.subarray(node.pointDataOffset, node.pointDataOffset + node.pointDataLength),
      }));
      const progress = (done: number, total: number) => {
        onProgress?.(`Lecture COPC ${done}/${total}...`, 10 + (done / total) * 50);
      };
      let decoded: DecodedCopcChunks | null = null;
      if (redviewLazModule) {
        try {
          initRedviewLaz(redviewLazModule);
          decoded = decodeCopcChunksWithRedviewLaz(copc.header, chunks, origin, progress);
        } catch (error) {
          console.warn('[LiDAR] LAZ decoder failed, decoding with laz-perf:', error);
        }
      }
      decoded ??= decodeCopcChunks(lazPerf, copc.header, chunks, origin, progress);
      const crs = hintCrs ?? detectCrs(decoded.bounds.minY, decoded.bounds.maxY, decoded.bounds.minX, decoded.bounds.maxX);
      const embeddedRgb = decoded.colors !== null && hasUsableEmbeddedRgb(decoded.maxRgb);
      onProgress?.('Prêt', 100);
      return {
        positions: decoded.positions,
        colors: embeddedRgb ? decoded.colors! : new Uint8Array(decoded.count * 3),
        classifications: decoded.classifications,
        intensities: decoded.intensities,
        count: decoded.count,
        bounds: decoded.bounds,
        origin,
        crs,
        embeddedRgb,
        copc: toCopcHierarchyInfo(allNodes, copc.info.cube, copc.info.spacing),
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const views: { v: any; count: number }[] = [];
    let loaded = 0;
    for (const node of allNodes) {
      const v = await Copc.loadPointDataView(getter, copc, node, { lazPerf });
      views.push({ v, count: v.pointCount });
      loaded++;
      onProgress?.(`Lecture COPC ${loaded}/${allNodes.length}...`, 10 + (loaded / allNodes.length) * 50);
    }

    const pointCount = views.reduce((s, v) => s + v.count, 0);
    const extracted = extractViewPoints(views, pointCount, origin);
    const crs = hintCrs ?? detectCrs(extracted.bounds.minY, extracted.bounds.maxY, extracted.bounds.minX, extracted.bounds.maxX);

    onProgress?.('Prêt', 100);
    return {
      ...extracted,
      count: pointCount,
      origin,
      crs,
      copc: toCopcHierarchyInfo(allNodes, copc.info.cube, copc.info.spacing),
    };
  } catch {
    // Not COPC — parse as regular LAZ/LAS
  }

  onProgress?.('Décompression LAZ...', 10);
  const header = Las.Header.parse(fileBytes);
  const origin = computeLocalOrigin(header.min);
  const extracted = decodeLasRecords(fileBytes, header, lazPerf, origin, (done) => {
    onProgress?.('Décompression LAZ...', 10 + done * 85);
  });
  const crs = hintCrs ?? detectCrs(extracted.bounds.minY, extracted.bounds.maxY, extracted.bounds.minX, extracted.bounds.maxX);

  onProgress?.('Prêt', 100);
  return { ...extracted, origin, crs };
}

/**
 * Budget de points d'un fichier LAS/LAZ non COPC. Au-delà (sous-dalles AHN
 * urbaines : jusqu'à ~100 M points), les points sont éclaircis uniformément
 * dans l'ordre du fichier — l'ordre spatial des dalles garde une densité
 * homogène (≥ 30 pts/m² sur une sous-dalle AHN de 1,3 km²).
 */
const LAS_POINT_BUDGET = 40_000_000;

interface LasRecordLayout {
  classOffset: number;
  /** Classes sur 5 bits (formats 0–5) ou 8 bits (formats 6–10). */
  classMask: number;
  rgbOffset: number | null;
}

function lasRecordLayout(pointDataRecordFormat: number): LasRecordLayout {
  if (pointDataRecordFormat <= 5) {
    const rgbOffset = pointDataRecordFormat === 2 ? 20 : pointDataRecordFormat === 3 || pointDataRecordFormat === 5 ? 28 : null;
    return { classOffset: 15, classMask: 0x1f, rgbOffset };
  }
  if (pointDataRecordFormat <= 10) {
    const rgbOffset = pointDataRecordFormat === 7 || pointDataRecordFormat === 8 || pointDataRecordFormat === 10 ? 30 : null;
    return { classOffset: 16, classMask: 0xff, rgbOffset };
  }
  throw new Error(`Format de point LAS ${pointDataRecordFormat} non pris en charge`);
}

/**
 * Lit les points d'un LAS (brut) ou LAZ (laz-perf, point par point) sans
 * matérialiser le tableau d'enregistrements complet (38 o/point en PDRF 8),
 * en ne gardant que ce qu'utilise le viewer — au plus `LAS_POINT_BUDGET`.
 */
function decodeLasRecords(
  fileBytes: Uint8Array,
  header: { pointCount: number; pointDataRecordFormat: number; pointDataRecordLength: number; pointDataOffset: number; scale: readonly number[]; offset: readonly number[] },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lazPerf: any,
  origin: PointCloudOrigin,
  onProgress?: (done: number) => void,
): Omit<PointCloudData, 'origin' | 'crs'> {
  const total = header.pointCount;
  const recordLength = header.pointDataRecordLength;
  const layout = lasRecordLayout(header.pointDataRecordFormat);
  const compressed = (fileBytes[104]! & 0xc0) !== 0;
  const count = Math.min(total, LAS_POINT_BUDGET);
  const [sx, sy, sz] = header.scale as [number, number, number];
  const ox = header.offset[0]! - origin.x;
  const oy = header.offset[1]! - origin.y;
  const oz = header.offset[2]! - origin.z;

  const positions = new Float32Array(count * 3);
  const classifications = new Uint8Array(count);
  const intensities = new Uint16Array(count);
  const colors = new Uint8Array(count * 3);
  // Octets de poids faible : certaines sources (sous-dalles AHN de GeoTiles)
  // stockent un RVB 8 bits dans les champs 16 bits ; l'échelle n'est connue
  // qu'une fois tous les points lus.
  const colorsLow = layout.rgbOffset !== null ? new Uint8Array(count * 3) : null;
  let maxRgb = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let kept = 0;
  let carry = 0;

  const take = (view: DataView, at: number) => {
    const x = view.getInt32(at, true) * sx + ox;
    const y = view.getInt32(at + 4, true) * sy + oy;
    const z = view.getInt32(at + 8, true) * sz + oz;
    const idx = kept * 3;
    positions[idx] = x;
    positions[idx + 1] = y;
    positions[idx + 2] = z;
    intensities[kept] = view.getUint16(at + 12, true);
    classifications[kept] = view.getUint8(at + layout.classOffset) & layout.classMask;
    if (colorsLow && layout.rgbOffset !== null) {
      const r = view.getUint16(at + layout.rgbOffset, true);
      const g = view.getUint16(at + layout.rgbOffset + 2, true);
      const b = view.getUint16(at + layout.rgbOffset + 4, true);
      colors[idx] = r >> 8;
      colors[idx + 1] = g >> 8;
      colors[idx + 2] = b >> 8;
      colorsLow[idx] = r;
      colorsLow[idx + 1] = g;
      colorsLow[idx + 2] = b;
      if (r > maxRgb) maxRgb = r;
      if (g > maxRgb) maxRgb = g;
      if (b > maxRgb) maxRgb = b;
    }
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    kept++;
  };
  // Éclaircissement de Bresenham : exactement `count` points sur `total`, à pas régulier.
  const shouldTake = () => {
    carry += count;
    if (carry < total) return false;
    carry -= total;
    return true;
  };
  const PROGRESS_STEP = 1_000_000;

  if (!compressed) {
    const end = header.pointDataOffset + total * recordLength;
    if (end > fileBytes.byteLength) throw new Error('Fichier LAS tronqué');
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    for (let i = 0; i < total && kept < count; i++) {
      if (shouldTake()) take(view, header.pointDataOffset + i * recordLength);
      if (i % PROGRESS_STEP === 0) onProgress?.(i / total);
    }
  } else {
    const filePointer = lazPerf._malloc(fileBytes.byteLength);
    const pointPointer = lazPerf._malloc(recordLength);
    const reader = new lazPerf.LASZip();
    try {
      lazPerf.HEAPU8.set(fileBytes, filePointer);
      reader.open(filePointer, fileBytes.byteLength);
      let heap: ArrayBuffer = lazPerf.HEAPU8.buffer;
      let view = new DataView(heap);
      for (let i = 0; i < total && kept < count; i++) {
        reader.getPoint(pointPointer);
        if (!shouldTake()) continue;
        if (lazPerf.HEAPU8.buffer !== heap) {
          heap = lazPerf.HEAPU8.buffer;
          view = new DataView(heap);
        }
        take(view, pointPointer);
        if (i % PROGRESS_STEP === 0) onProgress?.(i / total);
      }
    } finally {
      reader.delete();
      lazPerf._free(filePointer);
      lazPerf._free(pointPointer);
    }
  }

  if (kept < count) throw new Error(`Fichier LAS incomplet : ${kept}/${count} points lus`);
  // RVB 16 bits (norme LAS) : octet fort ; RVB 8 bits : octet faible ; tout à 0 : non colorisé.
  const embeddedRgb = maxRgb > 0;
  const rgb = hasUsableEmbeddedRgb(maxRgb) ? colors : embeddedRgb && colorsLow ? colorsLow : colors.fill(0);
  return {
    positions,
    classifications,
    intensities,
    colors: rgb,
    embeddedRgb,
    count,
    bounds: { minX: minX + origin.x, minY: minY + origin.y, minZ: minZ + origin.z, maxX: maxX + origin.x, maxY: maxY + origin.y, maxZ: maxZ + origin.z },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryGetter(view: any, dimension: string): ((index: number) => number) | null {
  try {
    return view.getter(dimension);
  } catch {
    return null;
  }
}

/**
 * Copies X/Y/Z (made relative to `origin` in float64), Classification and,
 * when the format has it, RGB out of copc Views.
 */
function extractViewPoints(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  views: { v: any; count: number }[],
  pointCount: number,
  origin: PointCloudOrigin,
): {
  positions: Float32Array;
  classifications: Uint8Array;
  intensities: Uint16Array;
  colors: Uint8Array;
  embeddedRgb: boolean;
  bounds: PointCloudBounds;
} {
  const positions = new Float32Array(pointCount * 3);
  const classifications = new Uint8Array(pointCount);
  const intensities = new Uint16Array(pointCount);
  const colors = new Uint8Array(pointCount * 3);
  let maxRgb = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let offset = 0;

  for (const { v, count } of views) {
    const getX = v.getter('X');
    const getY = v.getter('Y');
    const getZ = v.getter('Z');
    const getCls = v.getter('Classification');
    const getIntensity = tryGetter(v, 'Intensity');
    const getR = tryGetter(v, 'Red');
    const getG = tryGetter(v, 'Green');
    const getB = tryGetter(v, 'Blue');
    const hasRgb = getR !== null && getG !== null && getB !== null;
    for (let i = 0; i < count; i++) {
      const x = getX(i);
      const y = getY(i);
      const z = getZ(i);
      const idx = (offset + i) * 3;
      positions[idx] = x - origin.x;
      positions[idx + 1] = y - origin.y;
      positions[idx + 2] = z - origin.z;
      classifications[offset + i] = getCls(i);
      if (getIntensity) intensities[offset + i] = getIntensity(i);
      if (hasRgb) {
        const r = getR(i), g = getG(i), b = getB(i);
        colors[idx] = r >> 8;
        colors[idx + 1] = g >> 8;
        colors[idx + 2] = b >> 8;
        maxRgb = Math.max(maxRgb, r, g, b);
      }

      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    offset += count;
  }

  const embeddedRgb = hasUsableEmbeddedRgb(maxRgb);
  if (!embeddedRgb) colors.fill(0);
  return { positions, classifications, intensities, colors, embeddedRgb, bounds: { minX, minY, minZ, maxX, maxY, maxZ } };
}
