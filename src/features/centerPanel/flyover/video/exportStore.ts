import { useSyncExternalStore } from 'react';
import { longDurationBucket, trackAnalyticsEvent } from '@/shared/lib/analytics';
import type { FlyoverVideoOrientation } from './config';
import type { FlyoverVideoPhase, FlyoverVideoRequest } from './renderFlyoverVideo';

export type FlyoverVideoExportState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'running';
      readonly orientation: FlyoverVideoOrientation;
      readonly phase: FlyoverVideoPhase;
      readonly fraction: number;
      readonly frame: number;
      readonly totalFrames: number;
      readonly etaS: number | null;
      readonly videoDurationS: number | null;
    }
  | {
      readonly status: 'done';
      readonly fileName: string;
      readonly sizeBytes: number;
      readonly durationS: number;
      readonly elapsedS: number;
    }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'cancelled' };

const IDLE: FlyoverVideoExportState = { status: 'idle' };

let state: FlyoverVideoExportState = IDLE;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function setState(next: FlyoverVideoExportState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState(): FlyoverVideoExportState {
  return state;
}

/** État de l'export vidéo en cours (survit au démontage du panneau). */
export function useFlyoverVideoExport(): FlyoverVideoExportState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function isFlyoverVideoExportRunning(): boolean {
  return state.status === 'running';
}

export function cancelFlyoverVideoExport(): void {
  controller?.abort();
}

/** Revient à l'état de repos (message de fin lu). */
export function dismissFlyoverVideoExport(): void {
  if (state.status !== 'running') setState(IDLE);
}

function sanitizeFileName(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .toLowerCase() || 'flyover'
  );
}

export function flyoverVideoFileName(baseName: string, orientation: FlyoverVideoOrientation): string {
  return `${sanitizeFileName(baseName)}-flyover-${orientation === 'portrait' ? '9x16' : '16x9'}.mp4`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Un gros fichier est lu par le gestionnaire de téléchargement après le clic.
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = '';
};

/**
 * Écran gardé allumé pendant le rendu (Screen Wake Lock) : un portable met
 * son écran en veille au bout de quelques minutes (2 min sur batterie par
 * défaut sous macOS), la page masquée voit ses minuteries ralenties, puis la
 * machine s'endort et l'export s'arrête. Le verrou tombe quand la page est
 * masquée : repris à son retour. Rend la fonction qui le libère.
 */
function keepScreenAwake(): () => void {
  if (!('wakeLock' in navigator)) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;
  let done = false;
  const acquire = () => {
    if (done || requesting || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
    requesting = true;
    navigator.wakeLock
      .request('screen')
      .then((lock) => {
        if (done) void lock.release().catch(() => {});
        else sentinel = lock;
      })
      .catch(() => {
        /* refusé (économie d'énergie, permission) : le rendu continue sans */
      })
      .finally(() => {
        requesting = false;
      });
  };
  document.addEventListener('visibilitychange', acquire);
  acquire();
  return () => {
    done = true;
    document.removeEventListener('visibilitychange', acquire);
    void sentinel?.release().catch(() => {});
  };
}

/**
 * Lance le rendu de la vidéo (un seul à la fois) et la télécharge à la fin.
 * Rend `false` si un rendu est déjà en cours.
 */
export async function startFlyoverVideoExport(request: FlyoverVideoRequest & { fileName: string }): Promise<boolean> {
  if (state.status === 'running') return false;
  const abort = new AbortController();
  controller = abort;
  window.addEventListener('beforeunload', warnBeforeUnload);
  const releaseScreen = keepScreenAwake();
  const startedAt = performance.now();
  const trackOutcome = (outcome: 'done' | 'cancelled' | 'error') =>
    trackAnalyticsEvent({
      name: 'flyover_video_exported',
      data: { format: request.orientation, outcome, duration: longDurationBucket(performance.now() - startedAt) },
    });
  setState({
    status: 'running',
    orientation: request.orientation,
    phase: 'preparing',
    fraction: 0,
    frame: 0,
    totalFrames: 0,
    etaS: null,
    videoDurationS: null,
  });
  try {
    // Moteur de rendu et encodeur chargés à la demande : hors du bundle du tableau de bord.
    const { renderFlyoverVideo } = await import('./renderFlyoverVideo');
    const result = await renderFlyoverVideo(request, {
      signal: abort.signal,
      onProgress: (progress) => {
        if (state.status !== 'running' || abort.signal.aborted) return;
        setState({ ...state, ...progress });
      },
    });
    downloadBlob(result.blob, request.fileName);
    trackOutcome('done');
    setState({
      status: 'done',
      fileName: request.fileName,
      sizeBytes: result.blob.size,
      durationS: result.durationS,
      elapsedS: result.elapsedS,
    });
  } catch (error) {
    if (abort.signal.aborted) {
      trackOutcome('cancelled');
      setState({ status: 'cancelled' });
    } else {
      console.error('[flyover-video] export failed', error);
      trackOutcome('error');
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Rendu de la vidéo impossible.',
      });
    }
  } finally {
    controller = null;
    window.removeEventListener('beforeunload', warnBeforeUnload);
    releaseScreen();
  }
  return true;
}
