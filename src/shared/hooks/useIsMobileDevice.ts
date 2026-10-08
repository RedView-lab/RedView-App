import { useEffect, useState, useCallback } from 'react';

/**
 * Plus petite fenêtre (px CSS, l'interface est à 1:1) où le dashboard tient
 * sans chevauchement : un panneau latéral + panneau central (816 px de large),
 * outils carte compacts + panneau central court (~480 px de haut), voir
 * pages/Dashboard/lib/layout.ts. Une fenêtre demi-écran 1080p (~958 px) passe.
 */
export const MIN_VIEWPORT_WIDTH = 820;
export const MIN_VIEWPORT_HEIGHT = 500;
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
  return window.innerWidth < MIN_VIEWPORT_WIDTH || window.innerHeight < MIN_VIEWPORT_HEIGHT;
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
 * - `showNarrowViewportOverlay` : fenêtre de bureau trop petite (MIN_VIEWPORT_*) → simple
 *   superposition au-dessus de l'app, qui reste montée (historique, imports,
 *   contexte WebGL conservés). Disparaît d'elle-même quand la fenêtre est
 *   agrandie ; `dismissNarrowViewportOverlay` la masque pour la session.
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
      // On ignore les erreurs d'accès au stockage : la fermeture vaut quand même pour cette page.
    }
    setIsNarrowOverlayDismissed(true);
  }, []);

  return {
    isMobile,
    showNarrowViewportOverlay: !isMobile && isNarrow && !isNarrowOverlayDismissed,
    dismissNarrowViewportOverlay,
  };
}
