import { useEffect, useState, useCallback } from 'react';

/** Largeur de fenêtre en dessous de laquelle l'interface n'est plus confortable. */
export const NARROW_VIEWPORT_MAX_WIDTH = 960;
/** Taille d'écran max d'un « vrai » appareil mobile (téléphone, petite tablette). */
const MOBILE_DEVICE_MAX_WIDTH = 1024;

const NARROW_OVERLAY_DISMISS_STORAGE_KEY = 'redview:dismiss-narrow-viewport-overlay';

/**
 * Vrai appareil mobile, évalué une seule fois au démarrage : UA mobile ou pointeur
 * principal tactile (coarse), sur un petit écran. Un ordinateur dont on rétrécit
 * la fenêtre n'est jamais considéré comme mobile.
 */
function detectMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;

  const isMobileUA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent || '',
  );

  let hasCoarsePointer = false;
  try {
    hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  } catch {
    hasCoarsePointer = false;
  }

  const screenWidth = Math.min(
    window.innerWidth,
    window.screen?.width || window.innerWidth,
  );
  const isSmallScreen = screenWidth < MOBILE_DEVICE_MAX_WIDTH;

  return (isMobileUA || hasCoarsePointer) && isSmallScreen;
}

function isNarrowViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < NARROW_VIEWPORT_MAX_WIDTH;
}

function readNarrowOverlayDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(NARROW_OVERLAY_DISMISS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * - `isMobile` : vrai appareil mobile détecté au chargement → écran bloquant
 *   (l'app n'est pas montée).
 * - `showNarrowViewportOverlay` : fenêtre de bureau trop étroite → simple
 *   superposition au-dessus de l'app, qui reste montée (historique, imports,
 *   contexte WebGL conservés). Disparaît d'elle-même quand la fenêtre est
 *   ré-élargie ; `dismissNarrowViewportOverlay` la masque pour la session.
 */
export function useIsMobileDevice() {
  const [isMobile] = useState<boolean>(() => detectMobileDevice());
  const [isNarrow, setIsNarrow] = useState<boolean>(() => isNarrowViewport());
  const [isNarrowOverlayDismissed, setIsNarrowOverlayDismissed] = useState<boolean>(() =>
    readNarrowOverlayDismissed(),
  );

  useEffect(() => {
    if (isMobile) return;

    const handleResize = () => {
      setIsNarrow(isNarrowViewport());
    };

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleResize, { passive: true });

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [isMobile]);

  const dismissNarrowViewportOverlay = useCallback(() => {
    try {
      window.sessionStorage.setItem(NARROW_OVERLAY_DISMISS_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage access errors: dismissal still applies to this page.
    }
    setIsNarrowOverlayDismissed(true);
  }, []);

  return {
    isMobile,
    showNarrowViewportOverlay: !isMobile && isNarrow && !isNarrowOverlayDismissed,
    dismissNarrowViewportOverlay,
  };
}
