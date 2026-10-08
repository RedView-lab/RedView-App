import { fallbackViewerEngine, viewerEngineParamValue, VIEWER_ENGINE_PARAM, type ViewerEngineKey } from './viewerEngine';

const GPU_RETRY_STORAGE_KEY = 'redview-lidar-webgpu-retry-at';
const GPU_RETRY_WINDOW_MS = 120_000;

/**
 * Quitte un moteur dont le contexte GPU a été perdu. Le canvas garde son type
 * de contexte, le moteur suivant a donc besoin d'une page neuve : la première
 * perte recharge une fois le même moteur (les tuiles reviennent du cache OPFS),
 * une seconde dans les deux minutes descend la chaîne WebGPU → WebGL 2 → terrain.
 */
export function recoverFromGpuFailure(reason: string, running: ViewerEngineKey): void {
  const url = new URL(window.location.href);
  let recentRetry = false;
  try {
    const last = Number(window.sessionStorage.getItem(GPU_RETRY_STORAGE_KEY) || 0);
    recentRetry = Date.now() - last < GPU_RETRY_WINDOW_MS;
    window.sessionStorage.setItem(GPU_RETRY_STORAGE_KEY, String(Date.now()));
  } catch {
    recentRetry = true;
  }
  if (recentRetry) {
    const next = fallbackViewerEngine(running);
    console.warn(`[Viewer] ${running} failure (${reason}), switching to the ${next} engine.`);
    url.searchParams.set(VIEWER_ENGINE_PARAM, viewerEngineParamValue(next) ?? next);
  } else {
    console.warn(`[Viewer] ${running} failure (${reason}), reloading once.`);
  }
  window.location.replace(url.toString());
}
