import { useEffect } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { createOverlayStatus, type OverlayStatusReporter } from '@/features/map3d';

interface UseRouteOverlayStatusOptions {
  onRouteStatusChange?: OverlayStatusReporter;
  routeLoading: boolean;
  routeError: string | null;
  routeRequestNonce: number;
}

/** Reflète le calcul du tracé (chargement / erreur) dans la pastille d'état de la carte. */
export function useRouteOverlayStatus({
  onRouteStatusChange,
  routeLoading,
  routeError,
  routeRequestNonce,
}: UseRouteOverlayStatusOptions): void {
  const { t } = useAppI18n();

  useEffect(() => {
    if (!onRouteStatusChange) return;

    if (routeLoading) {
      onRouteStatusChange(createOverlayStatus({
        id: 'itinerary',
        label: t('Itinéraire'),
        state: 'loading',
        progress: 0,
        detail: t('Calcul du tracé en cours'),
        nonce: routeRequestNonce,
        reloadable: false,
      }));
      return;
    }

    if (routeError) {
      onRouteStatusChange(createOverlayStatus({
        id: 'itinerary',
        label: t('Itinéraire'),
        state: 'error',
        progress: 100,
        detail: routeError,
        reloadable: false,
      }));
      return;
    }

    onRouteStatusChange(null);
  }, [onRouteStatusChange, routeError, routeLoading, routeRequestNonce, t]);

  useEffect(() => {
    return () => {
      onRouteStatusChange?.(null);
    };
  }, [onRouteStatusChange]);
}
