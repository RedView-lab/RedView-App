import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { cloneItineraryForMutation } from '../../context/ProjectStore/historyClone';
import { buildPoiRouteSignature, resetPoisForRouteChange } from '../../lib/schedule';
import type { Itinerary, ItineraryProject } from '../../types';

interface UsePoiRouteInvalidationOptions {
  active: Itinerary | null;
  isMapLoaded: boolean;
  historyRevision: number;
  /** Routage ou recalcul du tracé en cours : on attend une trace stable. */
  routeBusy: boolean;
  pendingCorridorFor: string | null;
  setPendingCorridorFor: Dispatch<SetStateAction<string | null>>;
  setProjectWithoutHistory: Dispatch<SetStateAction<ItineraryProject>>;
  poiLoading: boolean;
  hasGpxRoute: boolean;
  hasEnabledCategories: boolean;
  searchCorridor: () => void;
  cancelSearchCorridor: () => void;
}

/**
 * Cycle de vie de la recherche POI vis-à-vis de la trace : recherche différée
 * (import GPX, trace modifiée), annulation sur undo/redo, et remise à zéro des
 * POI quand la trace a changé depuis la dernière recherche.
 */
export function usePoiRouteInvalidation({
  active,
  isMapLoaded,
  historyRevision,
  routeBusy,
  pendingCorridorFor,
  setPendingCorridorFor,
  setProjectWithoutHistory,
  poiLoading,
  hasGpxRoute,
  hasEnabledCategories,
  searchCorridor,
  cancelSearchCorridor,
}: UsePoiRouteInvalidationOptions): void {
  useEffect(() => {
    if (!pendingCorridorFor) return;
    if (!active || active.id !== pendingCorridorFor) return;
    if (!hasGpxRoute || !hasEnabledCategories || !isMapLoaded) return;
    const handle = setTimeout(() => {
      searchCorridor();
      setPendingCorridorFor(null);
    }, 50);
    return () => clearTimeout(handle);
  }, [
    pendingCorridorFor,
    active,
    hasGpxRoute,
    hasEnabledCategories,
    isMapLoaded,
    searchCorridor,
    setPendingCorridorFor,
  ]);

  // Undo / redo : une recherche POI lancée sur l'état quitté ne doit pas
  // s'appliquer à l'état restauré.
  const seenHistoryRevisionRef = useRef(historyRevision);
  useEffect(() => {
    if (seenHistoryRevisionRef.current === historyRevision) return;
    seenHistoryRevisionRef.current = historyRevision;
    if (poiLoading) cancelSearchCorridor();
  }, [cancelSearchCorridor, historyRevision, poiLoading]);

  // Trace modifiée (routage, import, inversion, annuler…) : POI, lignes de
  // feuille de route et tri auto portaient sur l'ancienne trace. Une fois la
  // trace stabilisée, on les retire et on relance la recherche (le tri auto
  // suit tout seul, ses entrées ayant changé).
  const activeRoutePoints = active?.gpxRoute?.points;
  const currentPoiRouteSignature = useMemo(
    () => buildPoiRouteSignature(activeRoutePoints),
    [activeRoutePoints],
  );
  const storedPoiRouteSignature = active?.poiRouteSignature;
  const activeHasPois = Boolean(
    active && ((active.poiFeatures?.length ?? 0) > 0 || active.timeline.some((row) => row.kind === 'poi')),
  );
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (!activeId || routeBusy) return;
    if (storedPoiRouteSignature === currentPoiRouteSignature) return;
    if (storedPoiRouteSignature === undefined) {
      // POI enregistrés avant l'empreinte : on les rattache à la trace courante.
      if (!activeHasPois) return;
      setProjectWithoutHistory((p) => ({
        ...p,
        itineraries: p.itineraries.map((it) =>
          it.id === activeId ? { ...it, poiRouteSignature: buildPoiRouteSignature(it.gpxRoute?.points) } : it,
        ),
      }));
      return;
    }
    if (poiLoading) cancelSearchCorridor();
    setProjectWithoutHistory((p) => ({
      ...p,
      itineraries: p.itineraries.map((it) => {
        if (it.id !== activeId) return it;
        const copy = cloneItineraryForMutation(it);
        resetPoisForRouteChange(copy);
        return copy;
      }),
    }));
    if (hasEnabledCategories) setPendingCorridorFor(activeId);
  }, [
    activeHasPois,
    activeId,
    cancelSearchCorridor,
    currentPoiRouteSignature,
    hasEnabledCategories,
    poiLoading,
    routeBusy,
    setPendingCorridorFor,
    setProjectWithoutHistory,
    storedPoiRouteSignature,
  ]);
}
