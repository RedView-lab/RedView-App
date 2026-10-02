import type { AltitudeRef, DetectedCrs, PointCloudBounds, PointCloudData, PointCloudOrigin } from '../types';
import { translateAppText } from '@/shared/i18n/config';
import type { WorkerRequest, WorkerResponse } from '../workers/processWorker';
import type { CopcDecodeRequest, CopcDecodeResponse } from '../workers/copcDecodeWorker';
import type { LodCacheRequest, LodCacheResponse } from '../workers/lodCacheWorker';
import type { LodTileInput } from './lod/lodTile';
import { createInMemoryLodTile, openLodTile, type OpenedLodTile } from '../lib/lodCache';
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

export { getLazWasmModule };

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

async function decodeCopcInParallel(
  buffer: ArrayBuffer,
  layout: Awaited<ReturnType<typeof readCopcLayout>>,
  wasmModule: WebAssembly.Module,
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
  const fileBytes = new Uint8Array(buffer);
  const totalChunks = layout.nodes.length;
  const doneByGroup = new Array<number>(groups.length).fill(0);
  const workers: Worker[] = [];

  try {
    const parts = await Promise.all(groups.map((group, groupIndex) => {
      const byteLength = group.reduce((sum, node) => sum + node.pointDataLength, 0);
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const node of group) {
        bytes.set(fileBytes.subarray(node.pointDataOffset, node.pointDataOffset + node.pointDataLength), offset);
        offset += node.pointDataLength;
      }

      const worker = new Worker(new URL('../workers/copcDecodeWorker.ts', import.meta.url), { type: 'module' });
      workers.push(worker);
      return new Promise<Extract<CopcDecodeResponse, { type: 'done' }>>((resolve, reject) => {
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
          } else if (msg.type === 'done') {
            resolve(msg);
          } else {
            reject(new Error(msg.message));
          }
        };
        worker.onerror = (err) => reject(new Error(err.message));
        const request: CopcDecodeRequest = {
          type: 'decode',
          header: layout.header,
          origin,
          bytes: bytes.buffer,
          pointCounts: group.map((node) => node.pointCount),
          byteLengths: group.map((node) => node.pointDataLength),
          wasmModule,
        };
        worker.postMessage(request, [bytes.buffer]);
      });
    }));

    const count = parts.reduce((sum, part) => sum + part.count, 0);
    const positions = new Float32Array(count * 3);
    const classifications = new Uint8Array(count);
    const intensities = new Uint16Array(count);
    const maxRgb = parts.reduce((max, part) => Math.max(max, part.maxRgb), 0);
    const colors = parts.every((part) => part.colors !== null) && hasUsableEmbeddedRgb(maxRgb)
      ? new Uint8Array(count * 3)
      : null;
    const bounds: PointCloudBounds = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    };
    let pointOffset = 0;
    for (const part of parts) {
      positions.set(part.positions, pointOffset * 3);
      classifications.set(part.classifications, pointOffset);
      intensities.set(part.intensities, pointOffset);
      if (colors && part.colors) colors.set(part.colors, pointOffset * 3);
      pointOffset += part.count;
      bounds.minX = Math.min(bounds.minX, part.bounds.minX);
      bounds.minY = Math.min(bounds.minY, part.bounds.minY);
      bounds.minZ = Math.min(bounds.minZ, part.bounds.minZ);
      bounds.maxX = Math.max(bounds.maxX, part.bounds.maxX);
      bounds.maxY = Math.max(bounds.maxY, part.bounds.maxY);
      bounds.maxZ = Math.max(bounds.maxZ, part.bounds.maxZ);
    }
    return { positions, classifications, intensities, colors, count, bounds, origin };
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
  buffer: ArrayBuffer,
  setStatus: ViewerStatusReporter,
  crs?: DetectedCrs,
  options?: { decodeWorkers?: number },
): Promise<PointCloudData> {
  const wasmModule = await getLazWasmModule().catch(() => null);
  const workerCount = options?.decodeWorkers ?? getDefaultDecodeWorkerCount();
  const layout = wasmModule && workerCount > 1
    ? await readCopcLayout(buffer).catch(() => null)
    : null;

  if (!wasmModule || !layout || layout.nodes.length < 2 || !canFastDecodeCopc(layout.header)) {
    return runProcessWorker(
      createProcessWorker(),
      { type: 'process', buffer, crs, wasmModule: wasmModule || undefined },
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

    const decoded = await decodeCopcInParallel(buffer, layout, wasmModule, workerCount, setStatus);
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

export type PreflightResult =
  | { ok: true; vendor: string; arch: string; desc: string }
  | { ok: false; code: 'no-webgpu' | 'no-adapter' | 'fallback-adapter' | 'software-adapter'; detail: string };

export async function preflightWebGPU(): Promise<PreflightResult> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { ok: false, code: 'no-webgpu', detail: translateAppText('navigator.gpu indisponible') };
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e: any) {
    return { ok: false, code: 'no-adapter', detail: e?.message || translateAppText('requestAdapter a échoué') };
  }
  if (!adapter) {
    return { ok: false, code: 'no-adapter', detail: translateAppText('Aucun GPUAdapter retourné') };
  }
  if ((adapter as any).isFallbackAdapter === true) {
    return { ok: false, code: 'fallback-adapter', detail: translateAppText('Adapter logiciel (fallback) détecté') };
  }
  const info = (adapter as any).info ?? {};
  const vendor = String(info.vendor ?? '').toLowerCase();
  const arch = String(info.architecture ?? '').toLowerCase();
  const desc = String(info.description ?? info.device ?? '').toLowerCase();
  const softwareSignatures = [
    'swiftshader',
    'llvmpipe',
    'lavapipe',
    'microsoft basic',
    'basic render',
    'warp',
  ];
  const haystack = `${vendor} ${arch} ${desc}`;
  if (softwareSignatures.some((signature) => haystack.includes(signature))) {
    return {
      ok: false,
      code: 'software-adapter',
      detail: translateAppText('Adapter logiciel : {{name}}', { name: desc || vendor || '?' }),
    };
  }
  return { ok: true, vendor, arch, desc };
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
  const card = createStyledElement('div', `
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
  console.warn(`[Viewer] Starting WebGL HD fallback — ${reasonForLog}`);
  setStatus('Bascule vers le moteur WebGL HD…', 4);
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

/** A buffer may back several views (e.g. cache reads); transfer each only once. */
function uniqueBuffers(transfer: Transferable[]): Transferable[] {
  return Array.from(new Set(transfer));
}