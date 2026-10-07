import type { AltitudeRef, DetectedCrs, PointCloudBounds, PointCloudData, PointCloudOrigin } from '../types';
import { translateAppText } from '@/shared/i18n/config';
import type { WorkerRequest, WorkerResponse } from '../workers/processWorker';
import type { CopcDecodeRequest, CopcDecodeResponse } from '../workers/copcDecodeWorker';
import type { LodCacheRequest, LodCacheResponse } from '../workers/lodCacheWorker';
import type { LodTileInput } from './lod/lodTile';
import { createInMemoryLodTile, openLodTile, type OpenedLodTile } from '../lib/lodCache';
import { getRedviewLazModule } from '../lib/laz/redviewLazModule';
import { getLazWasmModule } from '../lib/lazWasm';
import {
  canFastDecodeCopc,
  computeLocalOrigin,
  hasUsableEmbeddedRgb,
  readCopcLayout,
  toCopcHierarchyInfo,
} from '../lib/lazParser';
import { detectCrs } from '../lib/coordConvert';
import { loadTileByFileName } from '../lib/storage';

;

export interface ViewerDomElements {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  statusEl: HTMLElement;
  barFill: HTMLElement;
  statsEl: HTMLElement;
}

export type ViewerStatusReporter = (msg: string, pct?: number) => void;

/**
 * Translates a progress label posted by a decode worker. Workers have no
 * document/locale, so they post the French source text; dynamic forms
 * ("LAZ (1/3) : …", "Lecture COPC 4/10...") are re-keyed here.
 */
export function translateLidarWorkerProgress(message: string): string {
  const laz = /^LAZ \((\d+)\/(\d+)\) : (.*)$/.exec(message);
  if (laz) {
    return `LAZ (${laz[1]}/${laz[2]}) : ${translateLidarWorkerProgress(laz[3]!)}`;
  }
  const copc = /^Lecture COPC (\d+)\/(\d+)\.\.\.$/.exec(message);
  if (copc) {
    return translateAppText('Lecture COPC {{done}}/{{total}}...', { done: copc[1]!, total: copc[2]! });
  }
  return translateAppText(message);
}

export function setViewerStatus(
  statusEl: HTMLElement,
  barFill: HTMLElement,
  msg: string,
  pct?: number,
  extras?: {
    percentEl?: HTMLElement;
    detailEl?: HTMLElement;
  },
) {
  const isErrorState = /^(?:❌|⚠️)/.test(msg) || /\b(?:erreur|error)\b/i.test(msg) || /\b(?:impossible|unable)\b/i.test(msg);
  msg = translateAppText(msg);
  const visibleMessage = isErrorState ? msg : translateAppText('Chargement du Viewer LIDAR');
  statusEl.textContent = visibleMessage;
  statusEl.toggleAttribute('data-loading-error', isErrorState);
  if (!isErrorState) {
    statusEl.setAttribute('title', msg);
  } else {
    statusEl.removeAttribute('title');
  }

  if (extras?.detailEl) {
    extras.detailEl.textContent = msg;
  }

  if (pct != null) {
    const clampedPct = Math.max(0, Math.min(100, pct));
    const roundedPct = Math.round(clampedPct);
    barFill.style.width = `${clampedPct}%`;
    if (extras?.percentEl) {
      extras.percentEl.textContent = `${roundedPct}%`;
    }

    const progressHost = barFill.closest('[role="progressbar"]');
    if (progressHost) {
      progressHost.setAttribute('aria-valuenow', String(roundedPct));
      progressHost.setAttribute('aria-valuetext', msg);
    }
  }
}

export async function loadTileFromOPFS(tileFileNames: string[]): Promise<ArrayBuffer> {
  for (const name of tileFileNames) {
    try {
      const buffer = await loadTileByFileName(name);
      if (buffer) return buffer;
    } catch {
      // try next candidate
    }
  }
  throw new Error(translateAppText('Tuile introuvable dans le stockage local : {{file}}', {
    file: tileFileNames[0] ?? translateAppText('inconnue'),
  }));
}

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
  return new Worker(new URL('../workers/processWorker.ts', import.meta.url), { type: 'module' });
}

/** Default decode parallelism: leave one core for the UI thread. */
export function getDefaultDecodeWorkerCount(): number {
  const threads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(8, threads - 1));
}

/** Splits nodes into `groups` contiguous runs of roughly equal compressed size. */
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

/** A tile file handed over to the decoder, which empties the box once it no longer needs the bytes. */
export interface TileFileHolder {
  buffer: ArrayBuffer | null;
}

/**
 * Copies each group's compressed chunks out of the tile file, then drops the
 * file: the decode never holds the compressed tile twice (the file and the
 * copies sent to the workers). Its own frame, so nothing keeps the bytes alive.
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
 * Decodes a COPC tile on several workers. Each worker posts its points in
 * batches, copied at once into place in the tile's arrays (sized from the
 * hierarchy's point counts) and dropped; a worker is stopped as soon as it is
 * done, which frees its WASM memory. The tile thus peaks at its decoded arrays
 * plus a few batches, instead of every part, the assembled arrays and the
 * workers' memory at once (≈ 73 B/point measured on a 55.8 M-point tile).
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
  /** Embedded RGB when the file carries usable (16-bit scaled) colour, else null. */
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
      const worker = new Worker(new URL('../workers/copcDecodeWorker.ts', import.meta.url), { type: 'module' });
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
 * Decodes + colorizes a LAZ/COPC tile off the main thread.
 * COPC tiles are decoded by several workers in parallel while the ortho
 * imagery for the header extent is already downloading; other files use the
 * single-worker path.
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
    // Formats with RGB usually carry real colour: only prefetch orthophotos
    // when the file cannot provide it.
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

function createStyledElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cssText: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.style.cssText = cssText;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function showFatalError(
  overlay: HTMLElement,
  opts: { title: string; message: string; hint?: string; technical?: string },
) {
  overlay.classList.remove('hidden');

  // Construit via le DOM (textContent) : les messages peuvent contenir des
  // fragments non maîtrisés (erreurs worker, paramètres d'URL…).
  // Above #overlay::before like the loader card: that positioned layer's
  // backdrop blur otherwise covers an unpositioned card (the error was unreadable).
  const card = createStyledElement('div', `
      position: relative;
      z-index: 1;
      max-width: 560px;
      padding: 28px 32px;
      background: rgba(20, 24, 40, 0.85);
      border: 1px solid rgba(255, 80, 80, 0.35);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      color: #fff;
      font-family: system-ui, sans-serif;
      text-align: center;
    `);
  card.appendChild(createStyledElement('div', 'font-size: 40px; margin-bottom: 8px;', '⚠️'));
  card.appendChild(createStyledElement('h1', 'font-size: 1.35rem; margin: 0 0 12px; color:#ffb4b4;', translateAppText(opts.title)));
  card.appendChild(
    createStyledElement('p', 'font-size: 0.95rem; line-height: 1.55; color:#e6e8f0; margin: 0 0 14px;', translateAppText(opts.message)),
  );
  if (opts.hint) {
    card.appendChild(createStyledElement('p', 'font-size:0.85rem; color:#9aa3bd; margin:0 0 14px;', translateAppText(opts.hint)));
  }
  if (opts.technical) {
    const details = createStyledElement('details', 'margin-top:10px; text-align:left;');
    details.appendChild(
      createStyledElement('summary', 'cursor:pointer; color:#7ea1ff; font-size:0.8rem;', translateAppText('Détails techniques')),
    );
    details.appendChild(createStyledElement('pre', `
            margin-top: 8px; padding: 10px; font-size: 11px;
            background: rgba(0,0,0,0.45); border-radius: 6px;
            color:#cfd6e8; white-space: pre-wrap; word-break: break-word;
          `, opts.technical));
    card.appendChild(details);
  }
  const closeButton = createStyledElement('button', `
        margin-top: 18px; padding: 8px 18px;
        background: rgba(80,120,255,0.25); color:#fff;
        border: 1px solid rgba(120,160,255,0.55);
        border-radius: 999px; cursor: pointer; font-size: 0.9rem;
      `, translateAppText("Fermer l'onglet"));
  closeButton.id = 'err-close';
  closeButton.addEventListener('click', () => window.close());
  card.appendChild(closeButton);

  overlay.replaceChildren(card);
}

/**
 * What to try when no engine starts. On Linux the usual cause is the
 * browser's GPU acceleration being off or the driver blocklisted: without
 * it there is no WebGL at all (Chrome no longer falls back to SwiftShader).
 */
export function noEngineHint(): string {
  const ua = navigator.userAgent;
  if (/linux/i.test(ua) && !/android/i.test(ua)) {
    return "Sous Linux : activez l'accélération matérielle du navigateur (Chrome : chrome://settings/system puis chrome://gpu ; Firefox : about:support, section Graphiques) et installez des pilotes graphiques Mesa ou NVIDIA récents.";
  }
  return 'Mettez à jour vos pilotes graphiques ou utilisez un navigateur récent.';
}

export function explainWorkerError(raw: string): { title: string; message: string; hint?: string } {
  if (/Exception catching is disabled/i.test(raw) || /^\d{6,}\s*-\s*Exception/.test(raw)) {
    return {
      title: 'Décodage LAZ impossible',
      message:
        "Le décodeur LiDAR (laz-perf, WebAssembly) a levé une exception interne qu'il ne peut pas décrire. " +
        "C'est en général dû à une mémoire insuffisante pendant la décompression (les machines sans GPU dédié partagent leur RAM avec le processeur graphique) " +
        'ou à une tuile partiellement téléchargée.',
      hint:
        "Essayez de supprimer puis re-télécharger la tuile, fermez les autres onglets gourmands, " +
        "ou ouvrez le visualiseur sur une machine équipée d'une carte graphique dédiée.",
    };
  }
  return {
    title: 'Erreur de chargement',
    message: raw,
  };
}

export async function launchWebGLFallback({
  reasonForLog,
  dom,
  loadFromOPFS,
  altRef,
  tileLabel,
  tileCoord,
  sceneTileCoords,
  lidarManager,
  setStatus,
}: {
  reasonForLog: string;
  dom: ViewerDomElements;
  loadFromOPFS: () => Promise<ArrayBuffer | ArrayBuffer[]>;
  altRef: AltitudeRef;
  tileLabel: string;
  tileCoord?: import('../types').TileCoord;
  sceneTileCoords?: import('../types').TileCoord[];
  lidarManager?: import('../lib/lidarManager').LidarManager;
  setStatus: ViewerStatusReporter;
}): Promise<void> {
  console.warn(`[Viewer] Starting the terrain engine — ${reasonForLog}`);
  setStatus('Bascule vers le terrain texturé…', 4);
  const loaded = await loadFromOPFS();
  const buffers = Array.isArray(loaded) ? loaded : [loaded];
  const { runWebGLFallback } = await import('../../lidar/viewer-webgl/main');
  await runWebGLFallback(
    {
      canvas: dom.canvas,
      overlay: dom.overlay,
      status: dom.statusEl,
      bar: dom.barFill,
      stats: dom.statsEl,
      percent: dom.overlay.querySelector<HTMLElement>('#progress-percent') ?? undefined,
      detail: dom.overlay.querySelector<HTMLElement>('#status-detail') ?? undefined,
    },
    {
      buffers,
      altRefLabel: altRef,
      tileLabel,
      tileCoord,
      sceneTileCoords,
      lidarManager,
      reloadBuffer: async () => {
        const res = await loadFromOPFS();
        return Array.isArray(res) ? res[0]! : res;
      },
    },
  );
}

/**
 * Builds the tile's LOD octree in a worker and stores it in the OPFS LOD
 * cache, then reopens it for streaming. The point arrays of `pointCloud` are
 * transferred (detached): take any copy you need (heightmap) before.
 */
export function buildLodTileInWorker(
  lazFileName: string,
  pointCloud: PointCloudData,
  options: { persist: boolean } = { persist: true },
): Promise<OpenedLodTile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/lodCacheWorker.ts', import.meta.url), { type: 'module' });
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
 * Upgrades an older LOD cache of the tile in a worker (no decoding, see
 * `upgradeLegacyLodTile`) and opens the result; null when there is no
 * older cache to upgrade, so the caller rebuilds from the LAZ.
 */
export function upgradeLodTileInWorker(lazFileName: string): Promise<OpenedLodTile | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/lodCacheWorker.ts', import.meta.url), { type: 'module' });
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

/** A buffer may back several views (e.g. cache reads); transfer each only once. */
function uniqueBuffers(transfer: Transferable[]): Transferable[] {
  return Array.from(new Set(transfer));
}