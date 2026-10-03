import { createContext, useContext, useSyncExternalStore } from 'react';
import type { FlyoverController } from './FlyoverController';
import type { AnalysisFlyoverContextValue, FlyoverSeekToChartX } from './types';

export const AnalysisFlyoverContext = createContext<AnalysisFlyoverContextValue | null>(null);
export const FlyoverControllerContext = createContext<FlyoverController | null>(null);
export const FlyoverSeekContext = createContext<FlyoverSeekToChartX>(() => false);

const subscribeNothing = () => () => {};
const getNoCursor = () => null;

export function useAnalysisFlyover(): AnalysisFlyoverContextValue {
  const context = useContext(AnalysisFlyoverContext);
  if (!context) {
    throw new Error('useAnalysisFlyover must be used within <AnalysisFlyoverProvider>');
  }
  return context;
}

/** Seek par abscisse du graphique ; stable tant que la trace et l'axe ne changent pas. */
export function useFlyoverSeek(): FlyoverSeekToChartX {
  return useContext(FlyoverSeekContext);
}

/** Vrai pendant une session de lecture (tête et traînée sur la carte) ; ne re-rend qu'au changement. */
export function useFlyoverSessionActive(): boolean {
  const controller = useContext(FlyoverControllerContext);
  return useSyncExternalStore(controller?.subscribeStatus ?? subscribeNothing, () => controller?.getStatus().playbackActive ?? false);
}

/**
 * Abscisse du graphique où se trouve la tête de lecture (`null` hors
 * lecture). Mise à jour ≤ 30 Hz : seul le composant qui l'utilise se re-rend.
 */
export function useFlyoverCursorXValue(): number | null {
  const controller = useContext(FlyoverControllerContext);
  return useSyncExternalStore(controller?.subscribeCursor ?? subscribeNothing, controller?.getCursorX ?? getNoCursor);
}
