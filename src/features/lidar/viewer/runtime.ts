import type { AltitudeRef, DetectedCrs, PointCloudBounds, PointCloudData } from '../types';
import type { WorkerRequest, WorkerResponse } from '../workers/processWorker';
import type { CopcDecodeRequest, CopcDecodeResponse } from '../workers/copcDecodeWorker';
import type { AABB, FlatOctree, OctreeWorkerResponse } from './lod/types';
import { getLazWasmModule } from '../lib/lazWasm';
import { canFastDecodeCopc, readCopcLayout } from '../lib/lazParser';
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
  const isErrorState = /^(?:❌|⚠️)/.test(msg) || /\berreur\b/i.test(msg) || /\bimpossible\b/i.test(msg);
  const visibleMessage = isErrorState ? msg : 'Chargement du Viewer LIDAR';
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
  throw new Error(`Tuile introuvable dans le stockage local: ${tileFileNames[0] ?? 'inconnue'}`);
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
        setStatus(`${msg.phase === 'parsing' ? 'Parsing' : 'Colorisation'} : ${msg.message}`, base + msg.percent * scale);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          positions: msg.positions,
          colors: msg.colors,
          classifications: msg.classifications,
          count: msg.count,
          bounds: msg.bounds,
          crs: msg.crs as DetectedCrs,
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
): Promise<{ positions: Float32Array; classifications: Uint8Array; count: number; bounds: PointCloudBounds }> {
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
            setStatus(`Parsing : Lecture COPC ${done}/${totalChunks}...`, 15 + (10 + (done / totalChunks) * 50) * 0.35);
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
    const bounds: PointCloudBounds = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    };
    let pointOffset = 0;
    for (const part of parts) {
      positions.set(part.positions, pointOffset * 3);
      classifications.set(part.classifications, pointOffset);
      pointOffset += part.count;
      bounds.minX = Math.min(bounds.minX, part.bounds.minX);
      bounds.minY = Math.min(bounds.minY, part.bounds.minY);
      bounds.minZ = Math.min(bounds.minZ, part.bounds.minZ);
      bounds.maxX = Math.max(bounds.maxX, part.bounds.maxX);
      bounds.maxY = Math.max(bounds.maxY, part.bounds.maxY);
      bounds.maxZ = Math.max(bounds.maxZ, part.bounds.maxZ);
    }
    return { positions, classifications, count, bounds };
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
    const prefetchCrs = crs ?? detectCrs(minY, maxY, minX, maxX);
    colorWorker.postMessage({
      type: 'prefetch',
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
      crs: prefetchCrs,
    } satisfies WorkerRequest);

    const decoded = await decodeCopcInParallel(buffer, layout, wasmModule, workerCount, setStatus);
    const resolvedCrs = crs ?? detectCrs(decoded.bounds.minY, decoded.bounds.maxY, decoded.bounds.minX, decoded.bounds.maxX);
    return await runProcessWorker(
      colorWorker,
      { type: 'colorize', ...decoded, crs: resolvedCrs },
      [decoded.positions.buffer, decoded.classifications.buffer],
      setStatus,
    );
  } catch (error) {
    colorWorker.terminate();
    throw error;
  }
}

export type PreflightResult =
  | { ok: true; vendor: string; arch: string; desc: string }
  | { ok: false; code: 'no-webgpu' | 'no-adapter' | 'fallback-adapter' | 'software-adapter'; detail: string };

export async function preflightWebGPU(): Promise<PreflightResult> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { ok: false, code: 'no-webgpu', detail: 'navigator.gpu indisponible' };
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e: any) {
    return { ok: false, code: 'no-adapter', detail: e?.message || 'requestAdapter a échoué' };
  }
  if (!adapter) {
    return { ok: false, code: 'no-adapter', detail: 'Aucun GPUAdapter retourné' };
  }
  if ((adapter as any).isFallbackAdapter === true) {
    return { ok: false, code: 'fallback-adapter', detail: 'Adapter logiciel (fallback) détecté' };
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
    return { ok: false, code: 'software-adapter', detail: `Adapter logiciel: ${desc || vendor || 'inconnu'}` };
  }
  return { ok: true, vendor, arch, desc };
}

export function showFatalError(
  overlay: HTMLElement,
  opts: { title: string; message: string; hint?: string; technical?: string },
) {
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div style="
      max-width: 560px;
      padding: 28px 32px;
      background: rgba(20, 24, 40, 0.85);
      border: 1px solid rgba(255, 80, 80, 0.35);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      color: #fff;
      font-family: system-ui, sans-serif;
      text-align: center;
    ">
      <div style="font-size: 40px; margin-bottom: 8px;">⚠️</div>
      <h1 style="font-size: 1.35rem; margin: 0 0 12px; color:#ffb4b4;">${opts.title}</h1>
      <p style="font-size: 0.95rem; line-height: 1.55; color:#e6e8f0; margin: 0 0 14px;">${opts.message}</p>
      ${opts.hint ? `<p style="font-size:0.85rem; color:#9aa3bd; margin:0 0 14px;">${opts.hint}</p>` : ''}
      ${opts.technical ? `<details style="margin-top:10px; text-align:left;">
          <summary style="cursor:pointer; color:#7ea1ff; font-size:0.8rem;">Détails techniques</summary>
          <pre style="
            margin-top: 8px; padding: 10px; font-size: 11px;
            background: rgba(0,0,0,0.45); border-radius: 6px;
            color:#cfd6e8; white-space: pre-wrap; word-break: break-word;
          ">${opts.technical}</pre>
        </details>` : ''}
      <button id="err-close" style="
        margin-top: 18px; padding: 8px 18px;
        background: rgba(80,120,255,0.25); color:#fff;
        border: 1px solid rgba(120,160,255,0.55);
        border-radius: 999px; cursor: pointer; font-size: 0.9rem;
      ">Fermer l'onglet</button>
    </div>
  `;
  document.getElementById('err-close')?.addEventListener('click', () => window.close());
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

export function buildRGBA(pc: PointCloudData): Uint8Array {
  const rgba = new Uint8Array(pc.count * 4);
  const cls = pc.classifications;
  for (let index = 0; index < pc.count; index++) {
    rgba[index * 4 + 0] = pc.colors[index * 3 + 0]!;
    rgba[index * 4 + 1] = pc.colors[index * 3 + 1]!;
    rgba[index * 4 + 2] = pc.colors[index * 3 + 2]!;
    rgba[index * 4 + 3] = cls ? (cls[index] ?? 0) : 0;
  }
  return rgba;
}

export function centerPositions(pc: PointCloudData): { positions: Float32Array; origin: [number, number, number] } {
  const cx = (pc.bounds.minX + pc.bounds.maxX) / 2;
  const cy = (pc.bounds.minY + pc.bounds.maxY) / 2;
  const cz = (pc.bounds.minZ + pc.bounds.maxZ) / 2;

  const out = new Float32Array(pc.count * 3);
  for (let index = 0; index < pc.count; index++) {
    const offset = index * 3;
    out[offset + 0] = pc.positions[offset + 0] - cx;
    out[offset + 1] = pc.positions[offset + 2] - cz;
    out[offset + 2] = -(pc.positions[offset + 1] - cy);
  }

  return { positions: out, origin: [cx, cy, cz] };
}

export function buildOctreeInWorker(
  positions: Float32Array,
  colors: Uint8Array,
  bounds: AABB,
  setStatus: ViewerStatusReporter,
): Promise<FlatOctree> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lod/octreeWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<OctreeWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setStatus(`Octree: ${msg.message}`, 87 + msg.percent * 0.05);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          root: msg.root,
          leafPositions: msg.leafPositions,
          leafColors: msg.leafColors,
          voxelPositions: msg.voxelPositions,
          voxelColors: msg.voxelColors,
          totalLeafPoints: msg.totalLeafPoints,
          totalVoxelSamples: msg.totalVoxelSamples,
          maxDepthReached: msg.maxDepthReached,
          nodeCount: msg.nodeCount,
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

    worker.postMessage(
      { type: 'build', positions, colors, bounds },
      [positions.buffer, colors.buffer],
    );
  });
}