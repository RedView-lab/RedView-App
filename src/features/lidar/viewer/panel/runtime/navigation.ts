import { translateAppText } from '@/shared/i18n/config';
import { confirmDialog } from '@/shared/lib/appDialog';
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
 * Rouvre le viewer avec `targetEngine`. WebGPU et WebGL 2 dessinent le même
 * viewer ; le moteur terrain n'a pas de nuage de points, il demande donc d'abord.
 * Résout false quand rien ne change (même moteur, ou bascule annulée).
 */
export async function switchViewerEngine(targetEngine: ViewerEngineKey, runningEngine: ViewerEngineKey): Promise<boolean> {
  if (targetEngine === runningEngine) return false;
  if (targetEngine === 'terrain') {
    // Chargé à la demande : la feuille des pop-ins (partagée avec l'app) reste
    // hors du découpage commun des deux entrées.
    const { mountStandaloneAppDialogHost } = await import('@/shared/components/AppDialog/mountStandaloneAppDialogHost');
    mountStandaloneAppDialogHost();
    const confirmed = await confirmDialog({
      title: translateAppText('Basculer vers le terrain texturé ?'),
      message: translateAppText('Relief LiDAR texturé par l’orthophoto en haute résolution, sans nuage de points ni outils de mesure. Le sélecteur « Moteur » ramène au nuage de points.'),
      confirmLabel: translateAppText('Basculer'),
    });
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