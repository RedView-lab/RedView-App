import { useCallback, useMemo } from 'react';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { buildGpxQualityStats } from '@/features/itineraryPanel/lib/routes';
import type { GpxQualityMode, RouteRenderMode as ItinRouteRenderMode } from '@/features/itineraryPanel/types';
import { DEFAULT_CONTROL_PANEL_STATE } from '../../lib/defaultState';
import type { ControlPanelPersistedState } from '../../lib/persistedState';

interface UseControlPanelRoutesArgs {
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
}

/**
 * Gère l'état et l'affichage des traces GPX / itinéraires sur la carte 3D.
 */
export function useControlPanelRoutes({
  updateProjectControlPanel,
}: UseControlPanelRoutesArgs) {
  const projectStore = useProjectStoreOptional();
  const projectItineraries = projectStore?.project.itineraries ?? [];
  const projectControlPanel = projectStore?.project.controlPanel ?? null;

  const routesEnabled = projectControlPanel?.toggles.routesEnabled ?? true;
  const routeItems = useMemo(
    () =>
      projectItineraries.map((itinerary) => ({
        id: itinerary.id,
        label: itinerary.name,
        color: itinerary.color,
        mode: (itinerary.renderMode ?? 'default') as ItinRouteRenderMode,
        opacity: itinerary.opacity ?? 100,
        visible: itinerary.visible !== false,
      })),
    [projectItineraries],
  );

  const activeItineraryId = projectStore?.project.activeItineraryId;
  const activeItinerary = useMemo(
    () => projectItineraries.find((it) => it.id === activeItineraryId) ?? null,
    [projectItineraries, activeItineraryId],
  );

  const activeQualityRoute = useMemo(() => {
    const route = activeItinerary?.gpxRoute;
    return route && route.points.length >= 2 ? route : null;
  }, [activeItinerary]);

  const activeGpxQualityVisible = activeItinerary != null;
  const activeGpxQualityAvailable = activeQualityRoute != null;
  const activeGpxQuality = useMemo(
    () => (activeGpxQualityVisible ? activeItinerary?.gpxRoute?.gpxQuality ?? 'default' : null),
    [activeGpxQualityVisible, activeItinerary],
  );
  const activeGpxQualityPointsPerKm = useMemo(
    () => (activeGpxQualityVisible ? activeItinerary?.gpxRoute?.gpxQualityPointsPerKm ?? null : null),
    [activeGpxQualityVisible, activeItinerary],
  );
  const activeGpxQualityStats = useMemo(() => {
    const route = activeQualityRoute;
    if (!route) return null;
    const basePoints = route.originalPoints ?? route.points;
    return buildGpxQualityStats(
      route.points,
      basePoints,
      (route.gpxQuality ?? 'default') as GpxQualityMode,
      route.gpxQualityPointsPerKm,
    );
  }, [activeQualityRoute]);

  const routesTraceWidthPx =
    projectControlPanel?.routes?.traceWidthPx ?? DEFAULT_CONTROL_PANEL_STATE.routes.traceWidthPx;

  const routesSlice = {
    enabled: routesEnabled,
    items: routeItems,
    traceWidthPx: routesTraceWidthPx,
    gpxQuality: activeGpxQuality,
    gpxQualityAvailable: activeGpxQualityAvailable,
    gpxQualityPointsPerKm: activeGpxQualityPointsPerKm,
    gpxQualityStats: activeGpxQualityStats,
  };

  const handlers = {
    onRoutesEnabledChange: useCallback(
      (enabled: boolean) => {
        updateProjectControlPanel((draft) => {
          draft.toggles.routesEnabled = enabled;
        });
      },
      [updateProjectControlPanel],
    ),
    onRouteColorChange: useCallback(
      (id: string, color: string) => {
        projectStore?.setItineraryColor(id, color);
      },
      [projectStore],
    ),
    onRouteModeChange: useCallback(
      (id: string, mode: string) => {
        const allowed: ItinRouteRenderMode[] = ['default', 'slope', 'speedEst'];
        const safe = (allowed as string[]).includes(mode)
          ? (mode as ItinRouteRenderMode)
          : 'default';
        projectStore?.setItineraryRenderMode(id, safe);
      },
      [projectStore],
    ),
    onRouteOpacityChange: useCallback(
      (id: string, opacity: number) => {
        projectStore?.setItineraryOpacity(id, opacity);
      },
      [projectStore],
    ),
    onRouteTraceWidthChange: useCallback(
      (value: number) => {
        updateProjectControlPanel((draft) => {
          draft.routes = {
            traceWidthPx: Math.max(1, Math.min(20, Math.round(value))),
          };
        });
      },
      [updateProjectControlPanel],
    ),
    onRouteQualityChange: useCallback(
      (quality: GpxQualityMode) => {
        if (!projectStore || !activeItineraryId) return;
        projectStore.changeItineraryGpxQuality(activeItineraryId, quality);
      },
      [activeItineraryId, projectStore],
    ),
    onRouteQualityExpertApply: useCallback(
      (pointsPerKm: number) => {
        if (!projectStore || !activeItineraryId) return;
        projectStore.changeItineraryGpxQuality(activeItineraryId, 'expert', { pointsPerKm });
      },
      [activeItineraryId, projectStore],
    ),
    onRouteVisibilityToggle: useCallback(
      (id: string) => {
        if (!projectStore) return;
        const current = projectStore.project.itineraries.find((itinerary) => itinerary.id === id);
        if (!current) return;
        projectStore.setItineraryVisibility(id, current.visible === false);
      },
      [projectStore],
    ),
  };

  return { routesSlice, handlers };
}
