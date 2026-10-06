import { translateAppText } from '@/shared/i18n/config';
import { VIEWER_ENGINE_PARAM, viewerEngineParamValue, type ViewerEngineKey } from '../../session/viewerEngine';

function getSafeReferrerUrl(): string | null {
  if (!document.referrer) return null;

  try {
    const referrerUrl = new URL(document.referrer);
    if (referrerUrl.origin !== window.location.origin) return null;
    if (referrerUrl.pathname.endsWith('/viewer.html')) return null;
    return referrerUrl.toString();
  } catch {
    return null;
  }
}

/**
 * Reopens the viewer with `targetEngine`. WebGPU and WebGL 2 draw the same
 * viewer; the terrain engine has no point cloud, so it asks first.
 * Returns false when nothing changes (same engine, or switch cancelled).
 */
export function switchViewerEngine(targetEngine: ViewerEngineKey, runningEngine: ViewerEngineKey): boolean {
  if (targetEngine === runningEngine) return false;
  if (targetEngine === 'terrain') {
    const confirmed = window.confirm(translateAppText(
      'Basculer vers le terrain texturé ?\n\n' +
      '• Relief LiDAR texturé par l\'orthophoto en haute résolution\n' +
      '• Pas de nuage de points ni d\'outils de mesure\n' +
      '• Le sélecteur « Moteur » ramène au nuage de points.'
    ));
    if (!confirmed) return false;
  }
  const url = new URL(window.location.href);
  const value = viewerEngineParamValue(targetEngine);
  if (value) url.searchParams.set(VIEWER_ENGINE_PARAM, value);
  else url.searchParams.delete(VIEWER_ENGINE_PARAM);
  window.location.assign(url.toString());
  return true;
}

export function exitLidarViewer(): void {
  const fallbackUrl = getSafeReferrerUrl();

  if (window.opener && !window.opener.closed) {
    window.close();
    window.setTimeout(() => {
      if (document.hidden) return;
      if (fallbackUrl) {
        window.location.assign(fallbackUrl);
        return;
      }
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      window.location.assign('/');
    }, 150);
    return;
  }

  if (fallbackUrl) {
    window.location.assign(fallbackUrl);
    return;
  }

  if (window.history.length > 1) {
    window.history.back();
    return;
  }

  window.location.assign('/');
}