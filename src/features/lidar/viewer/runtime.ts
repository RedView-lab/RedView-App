import type { AltitudeRef } from '../types';
import { translateAppText } from '@/shared/i18n/config';
import { loadTileByFileName } from '../lib/storage';

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
