import type { DetectedCrs, PointCloudBounds, PointCloudData, PointCloudOrigin } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import type { WorkerRequest, WorkerResponse } from '../../workers/processWorker';
import type { CopcDecodeRequest, CopcDecodeResponse } from '../../workers/copcDecodeWorker';
import type { LodCacheRequest, LodCacheResponse } from '../../workers/lodCacheWorker';
import type { LodTileInput } from '../lod/lodTile';
import { createInMemoryLodTile, openLodTile, type OpenedLodTile } from '../../lib/lodCache';
import { getRedviewLazModule } from '../../lib/laz/redviewLazModule';
import { getLazWasmModule } from '../../lib/lazWasm';
import {
  canFastDecodeCopc,
  computeLocalOrigin,
  hasUsableEmbeddedRgb,
  readCopcLayout,
  toCopcHierarchyInfo,
} from '../../lib/lazParser';
import { detectCrs } from '../../lib/coordConvert';


import { translateLidarWorkerProgress, type ViewerStatusReporter } from '../runtime';

function runProcessWorker(
  worker: Worker,
  request: WorkerRequest,
  transfer: Transferable[],
  setStatus: ViewerStatusReporter,
): Promise<PointCloudData> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const base = msg.phase === 'parsing' ? 15 : 50;
        const scale = msg.phase === 'parsing' ? 0.35 : 0.3;
        setStatus(
          translateAppText(msg.phase === 'parsing' ? 'Analyse : {{step}}' : 'Colorisation : {{step}}', {
            step: translateLidarWorkerProgress(msg.message),
          }),
          base + msg.percent * scale,
        );
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          positions: msg.positions,
          colors: msg.colors,
          classifications: msg.classifications,
          count: msg.count,
          bounds: msg.bounds,
          origin: msg.origin,
          crs: msg.crs as DetectedCrs,
          intensities: msg.intensities,
          copc: msg.copc,
        });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };

    worker.postMessage(request, transfer);
  });
}

function createProcessWorker(): Worker {
  return new Worker(new URL('../../workers/processWorker.ts', import.meta.url), { type: 'module' });
}

/** Parallélisme de décodage par défaut : laisser un cœur au thread de l'interface. */
export function getDefaultDecodeWorkerCount(): number {
  const threads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(8, threads - 1));
}

/** Découpe les nœuds en `groups` séries contiguës de taille compressée à peu près égale. */
function splitContiguous<T extends { pointDataLength: number }>(nodes: T[], groups: number): T[][] {
  const total = nodes.reduce((sum, node) => sum + node.pointDataLength, 0);
  const target = total / groups;
  const result: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const node of nodes) {
    current.push(node);
    currentBytes += node.pointDataLength;
    if (currentBytes >= target && result.length < groups - 1) {
      result.push(current);
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Un fichier de tuile transmis au décodeur, qui vide la boîte dès qu'il n'a plus besoin des octets. */
export interface TileFileHolder {
  buffer: ArrayBuffer | null;
}

/**
 * Copie les chunks compressés de chaque groupe hors du fichier de la tuile,
 * puis libère le fichier : le décodage ne garde jamais la tuile compressée en
 * double (le fichier et les copies envoyées aux workers). Dans sa propre
 * frame, pour que rien ne garde les octets en vie.
 */
function takeGroupBytes(file: TileFileHolder, groups: Array<Array<{ pointDataOffset: number; pointDataLength: number }>>): Uint8Array[] {
  const fileBytes = new Uint8Array(file.buffer!);
  const copies = groups.map((group) => {
    const bytes = new Uint8Array(group.reduce((sum, node) => sum + node.pointDataLength, 0));
    let offset = 0;
    for (const node of group) {
      bytes.set(fileBytes.subarray(node.pointDataOffset, node.pointDataOffset + node.pointDataLength), offset);
      offset += node.pointDataLength;
    }
    return bytes;
  });
  file.buffer = null;
  return copies;
}

/**
 * Décode une tuile COPC sur plusieurs workers. Chaque worker envoie ses points
 * par lots, copiés aussitôt à leur place dans les tableaux de la tuile
 * (dimensionnés d'après les nombres de points de la hiérarchie) puis libérés ;
 * un worker est arrêté dès qu'il a fini, ce qui libère sa mémoire WASM. La tuile
 * plafonne ainsi à ses tableaux décodés plus quelques lots, au lieu de toutes
 * les parties, des tableaux assemblés et de la mémoire des workers à la fois
 * (≈ 73 o/point mesurés sur une tuile de 55,8 M points).
 */
async function decodeCopcInParallel(
  file: TileFileHolder,
  layout: Awaited<ReturnType<typeof readCopcLayout>>,
  wasmModule: WebAssembly.Module,
  redviewLazModule: WebAssembly.Module | null,
  workerCount: number,
  setStatus: ViewerStatusReporter,
): Promise<{
  positions: Float32Array;
  classifications: Uint8Array;
  intensities: Uint16Array;
  /** RVB intégré quand le fichier porte une couleur utilisable (à l'échelle 16 bits), sinon null. */
  colors: Uint8Array | null;
  count: number;
  bounds: PointCloudBounds;
  origin: PointCloudOrigin;
}> {
  const origin = computeLocalOrigin(layout.header.min);
  const groups = splitContiguous(layout.nodes, Math.max(1, Math.min(workerCount, layout.nodes.length)));
  const groupBytes: Array<Uint8Array | null> = takeGroupBytes(file, groups);
  const totalChunks = layout.nodes.length;
  const doneByGroup = new Array<number>(groups.length).fill(0);
  const groupStarts: number[] = [];
  let count = 0;
  for (const group of groups) {
    groupStarts.push(count);
    count += group.reduce((sum, node) => sum + node.pointCount, 0);
  }

  const positions = new Float32Array(count * 3);
  const classifications = new Uint8Array(count);
  const intensities = new Uint16Array(count);
  let colors: Uint8Array | null = null;
  let everyPartHasColors = true;
  let maxRgb = 0;
  const bounds: PointCloudBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
  const workers: Worker[] = [];

  try {
    await Promise.all(groups.map((group, groupIndex) => new Promise<void>((resolve, reject) => {
      const groupStart = groupStarts[groupIndex]!;
      const groupEnd = groupStarts[groupIndex + 1] ?? count;
      let cursor = groupStart;
      const worker = new Worker(new URL('../../workers/copcDecodeWorker.ts', import.meta.url), { type: 'module' });
      workers.push(worker);
      worker.onmessage = (e: MessageEvent<CopcDecodeResponse>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          doneByGroup[groupIndex] = msg.done;
          const done = doneByGroup.reduce((sum, value) => sum + value, 0);
          setStatus(
            translateAppText('Analyse : {{step}}', {
              step: translateAppText('Lecture COPC {{done}}/{{total}}...', { done, total: totalChunks }),
            }),
            15 + (10 + (done / totalChunks) * 50) * 0.35,
          );
        } else if (msg.type === 'part') {
          if (cursor + msg.count > groupEnd) {
            reject(new Error(`COPC: more points decoded than the hierarchy announces (${groupEnd - groupStart})`));
            return;
          }
          positions.set(msg.positions, cursor * 3);
          classifications.set(msg.classifications, cursor);
          intensities.set(msg.intensities, cursor);
          if (msg.colors) {
            colors ??= new Uint8Array(count * 3);
            colors.set(msg.colors, cursor * 3);
          } else {
            everyPartHasColors = false;
          }
          cursor += msg.count;
          maxRgb = Math.max(maxRgb, msg.maxRgb);
          bounds.minX = Math.min(bounds.minX, msg.bounds.minX);
          bounds.minY = Math.min(bounds.minY, msg.bounds.minY);
          bounds.minZ = Math.min(bounds.minZ, msg.bounds.minZ);
          bounds.maxX = Math.max(bounds.maxX, msg.bounds.maxX);
          bounds.maxY = Math.max(bounds.maxY, msg.bounds.maxY);
          bounds.maxZ = Math.max(bounds.maxZ, msg.bounds.maxZ);
        } else if (msg.type === 'done') {
          worker.terminate();
          if (cursor !== groupEnd) {
            reject(new Error(`COPC: ${cursor - groupStart} points decoded out of ${groupEnd - groupStart}`));
          } else {
            resolve();
          }
        } else {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (err) => reject(new Error(err.message));
      const bytes = groupBytes[groupIndex]!;
      groupBytes[groupIndex] = null;
      const request: CopcDecodeRequest = {
        type: 'decode',
        header: layout.header,
        origin,
        bytes: bytes.buffer as ArrayBuffer,
        pointCounts: group.map((node) => node.pointCount),
        byteLengths: group.map((node) => node.pointDataLength),
        wasmModule,
        redviewLazModule,
      };
      worker.postMessage(request, [bytes.buffer]);
    })));

    const embedded = everyPartHasColors && hasUsableEmbeddedRgb(maxRgb) ? colors : null;
    return { positions, classifications, intensities, colors: embedded, count, bounds, origin };
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

/**
 * Décode + colorise une tuile LAZ/COPC hors du thread principal.
 * Les tuiles COPC sont décodées par plusieurs workers en parallèle pendant que
 * l'imagerie ortho de l'emprise de l'en-tête se télécharge déjà ; les autres
 * fichiers prennent le chemin à un seul worker.
 */
export async function processPointCloudInWorker(
  file: TileFileHolder,
  setStatus: ViewerStatusReporter,
  crs?: DetectedCrs,
  options?: { decodeWorkers?: number },
): Promise<PointCloudData> {
  const [wasmModule, redviewLazModule] = await Promise.all([
    getLazWasmModule().catch(() => null),
    getRedviewLazModule(),
  ]);
  const workerCount = options?.decodeWorkers ?? getDefaultDecodeWorkerCount();
  const layout = wasmModule && workerCount > 1
    ? await readCopcLayout(file.buffer!).catch(() => null)
    : null;

  if (!wasmModule || !layout || layout.nodes.length < 2 || !canFastDecodeCopc(layout.header)) {
    const buffer = file.buffer!;
    file.buffer = null;
    return runProcessWorker(
      createProcessWorker(),
      { type: 'process', buffer, crs, wasmModule: wasmModule || undefined, redviewLazModule },
      [buffer],
      setStatus,
    );
  }

  const colorWorker = createProcessWorker();
  try {
    const [minX, minY, minZ] = layout.header.min as [number, number, number];
    const [maxX, maxY, maxZ] = layout.header.max as [number, number, number];
    // Les formats avec RVB portent en général une vraie couleur : ne précharger
    // les orthophotos que si le fichier ne peut pas la fournir.
    if (!fileFormatHasRgb(layout.header.pointDataRecordFormat)) {
      colorWorker.postMessage({
        type: 'prefetch',
        bounds: { minX, minY, minZ, maxX, maxY, maxZ },
        crs: crs ?? detectCrs(minY, maxY, minX, maxX),
      } satisfies WorkerRequest);
    }

    const decoded = await decodeCopcInParallel(file, layout, wasmModule, redviewLazModule, workerCount, setStatus);
    const resolvedCrs = crs ?? detectCrs(decoded.bounds.minY, decoded.bounds.maxY, decoded.bounds.minX, decoded.bounds.maxX);
    const copc = toCopcHierarchyInfo(layout.nodes, layout.cube, layout.spacing);
    if (decoded.colors) {
      colorWorker.terminate();
      return {
        positions: decoded.positions,
        colors: decoded.colors,
        classifications: decoded.classifications,
        intensities: decoded.intensities,
        count: decoded.count,
        bounds: decoded.bounds,
        origin: decoded.origin,
        crs: resolvedCrs,
        embeddedRgb: true,
        copc,
      };
    }
    const colorized = await runProcessWorker(
      colorWorker,
      {
        type: 'colorize',
        positions: decoded.positions,
        classifications: decoded.classifications,
        count: decoded.count,
        bounds: decoded.bounds,
        origin: decoded.origin,
        crs: resolvedCrs,
      },
      [decoded.positions.buffer, decoded.classifications.buffer],
      setStatus,
    );
    return { ...colorized, intensities: decoded.intensities, copc };
  } catch (error) {
    colorWorker.terminate();
    throw error;
  }
}

function fileFormatHasRgb(pointDataRecordFormat: number): boolean {
  const format = pointDataRecordFormat & 0x3f;
  return format === 2 || format === 3 || format === 5 || format === 7 || format === 8 || format === 10;
}

/**
 * Construit l'octree LOD de la tuile dans un worker et le stocke dans le cache
 * LOD OPFS, puis le rouvre pour le flux. Les tableaux de points de `pointCloud`
 * sont transférés (détachés) : faire avant toute copie nécessaire (heightmap).
 */
export function buildLodTileInWorker(
  lazFileName: string,
  pointCloud: PointCloudData,
  options: { persist: boolean } = { persist: true },
): Promise<OpenedLodTile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/lodCacheWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = async (e: MessageEvent<LodCacheResponse>) => {
      const msg = e.data;
      worker.terminate();
      if (msg.type === 'error') {
        reject(new Error(msg.message));
        return;
      }
      if (msg.type !== 'done') {
        reject(new Error(`Unexpected LOD worker reply: ${msg.type}`));
        return;
      }
      if (!msg.stored && msg.packed) {
        resolve(createInMemoryLodTile({ header: msg.header, nodes: msg.nodes, packed: msg.packed }));
        return;
      }
      const opened = await openLodTile(lazFileName);
      if (opened) resolve(opened);
      else reject(new Error(translateAppText('Cache LOD illisible après écriture : {{file}}', { file: lazFileName })));
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };

    const input: LodTileInput = {
      positions: pointCloud.positions,
      colors: pointCloud.colors,
      classifications: pointCloud.classifications,
      intensities: pointCloud.intensities,
      count: pointCloud.count,
      bounds: pointCloud.bounds,
      origin: pointCloud.origin,
      crs: pointCloud.crs,
      embeddedRgb: pointCloud.embeddedRgb,
      copc: pointCloud.copc,
    };
    const transfer: Transferable[] = [pointCloud.positions.buffer, pointCloud.colors.buffer, pointCloud.classifications.buffer];
    if (pointCloud.intensities) transfer.push(pointCloud.intensities.buffer);
    worker.postMessage(
      { type: 'build', lazFileName, input, persist: options.persist } satisfies LodCacheRequest,
      uniqueBuffers(transfer),
    );
  });
}

/**
 * Met à niveau un ancien cache LOD de la tuile dans un worker (sans décodage,
 * voir `upgradeLegacyLodTile`) et ouvre le résultat ; null quand il n'y a pas
 * d'ancien cache à mettre à niveau, l'appelant reconstruit alors depuis le LAZ.
 */
export function upgradeLodTileInWorker(lazFileName: string): Promise<OpenedLodTile | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../../workers/lodCacheWorker.ts', import.meta.url), { type: 'module' });
    const finish = (tile: OpenedLodTile | null) => {
      worker.terminate();
      resolve(tile);
    };
    worker.onmessage = async (e: MessageEvent<LodCacheResponse>) => {
      const msg = e.data;
      if (msg.type === 'error') console.warn(`[Viewer] LOD cache upgrade failed for ${lazFileName}:`, msg.message);
      finish(msg.type === 'upgraded' && msg.upgraded ? await openLodTile(lazFileName) : null);
    };
    worker.onerror = (err) => {
      console.warn(`[Viewer] LOD cache upgrade failed for ${lazFileName}:`, err.message);
      finish(null);
    };
    worker.postMessage({ type: 'upgrade', lazFileName } satisfies LodCacheRequest);
  });
}

/** Un buffer peut porter plusieurs vues (par ex. lectures du cache) : ne transférer chacun qu'une fois. */
function uniqueBuffers(transfer: Transferable[]): Transferable[] {
  return Array.from(new Set(transfer));
}
