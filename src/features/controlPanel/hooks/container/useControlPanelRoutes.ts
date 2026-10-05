import { useCallback, useMemo } from 'react';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import type { RouteDisplayQuality, RouteRenderMode as ItinRouteRenderMode } from '@/features/itineraryPanel/types';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '@/features/itineraryPanel/lib/route-layer/constants';
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

  const routesTraceWidthPx =
    projectControlPanel?.routes?.traceWidthPx ?? DEFAULT_CONTROL_PANEL_STATE.routes.traceWidthPx;

  const routesSlice = {
    enabled: routesEnabled,
    items: routeItems,
    traceWidthPx: routesTraceWidthPx,
    quality: projectControlPanel?.routes?.quality ?? 'auto',
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
            ...draft.routes,
            traceWidthPx: Math.max(1, Math.min(20, Math.round(value))),
          };
        });
      },
      [updateProjectControlPanel],
    ),
    // Vue (par utilisateur) : ne réécrit jamais les points des itinéraires.
    onRouteQualityChange: useCallback(
      (quality: RouteDisplayQuality) => {
        updateProjectControlPanel((draft) => {
          draft.routes = {
            traceWidthPx: DEFAULT_ROUTE_TRACE_WIDTH_PX,
            ...draft.routes,
            quality,
          };
        });
      },
      [updateProjectControlPanel],
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
