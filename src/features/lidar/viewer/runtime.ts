import type { AltitudeRef, DetectedCrs, PointCloudData } from '../types';
import type { WorkerResponse } from '../workers/processWorker';
import type { AABB, FlatOctree, OctreeWorkerResponse } from './lod/types';

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
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('lidar-hd');
  for (const name of tileFileNames) {
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return file.arrayBuffer();
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Tile not found in OPFS: ${tileFileNames[0] ?? 'unknown tile'}`);
}

export function processPointCloudInWorker(
  buffer: ArrayBuffer,
  setStatus: ViewerStatusReporter,
  crs?: DetectedCrs,
): Promise<PointCloudData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/processWorker.ts', import.meta.url), { type: 'module' });

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

    worker.postMessage({ type: 'process', buffer, crs }, [buffer]);
  });
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