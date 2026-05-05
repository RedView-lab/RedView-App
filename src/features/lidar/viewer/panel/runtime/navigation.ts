import type { ViewerEngineKey } from '../controller';

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

export function switchViewerEngine(targetEngine: ViewerEngineKey): void {
  const url = new URL(window.location.href);
  const currentEngine = url.searchParams.get('engine') === 'webgl' ? 'webgl' : 'webgpu';

  if (targetEngine === currentEngine) return;

  if (targetEngine === 'webgl') {
    const confirmed = window.confirm(
      'Basculer vers le moteur WebGL HD ?\n\n' +
      '• Terrain texturé orthophoto en haute résolution\n' +
      '• Pas de nuage de points LiDAR (compatible toutes machines)\n' +
      '• Action irréversible : il faudra recharger pour revenir à WebGPU.'
    );
    if (!confirmed) return;
    url.searchParams.set('engine', 'webgl');
  } else {
    url.searchParams.delete('engine');
  }

  window.location.assign(url.toString());
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