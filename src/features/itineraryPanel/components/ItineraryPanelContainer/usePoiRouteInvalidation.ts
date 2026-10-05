import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { useDerivedComputeGate } from '../../context/ProjectStore/hooks';
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

/** Au-delà, une recherche annoncée aux autres éditeurs est considérée finie. */
const POI_COMPUTE_ANNOUNCE_MAX_MS = 90_000;

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
  // Co-édition : seul l'auteur du changement de trace relance la recherche ;
  // elle est annoncée aux autres éditeurs jusqu'à son résultat.
  const { gate, retryNonce: gateRetryNonce, markWaiting: markWaitingForGate } = useDerivedComputeGate();
  const poiComputeRef = useRef<{ release: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const sawPoiLoadingRef = useRef(false);
  const releasePoiCompute = useCallback(() => {
    const current = poiComputeRef.current;
    if (!current) return;
    poiComputeRef.current = null;
    clearTimeout(current.timer);
    current.release();
  }, []);
  const announcePoiCompute = useCallback((itineraryId: string) => {
    releasePoiCompute();
    poiComputeRef.current = {
      release: gate.beginCompute('poi', itineraryId),
      timer: setTimeout(releasePoiCompute, POI_COMPUTE_ANNOUNCE_MAX_MS),
    };
  }, [gate, releasePoiCompute]);
  useEffect(() => {
    if (poiLoading) {
      sawPoiLoadingRef.current = true;
      return;
    }
    if (pendingCorridorFor || !sawPoiLoadingRef.current) return;
    // Recherche terminée (sinon l'annonce expire d'elle-même).
    sawPoiLoadingRef.current = false;
    releasePoiCompute();
  }, [pendingCorridorFor, poiLoading, releasePoiCompute]);
  useEffect(() => releasePoiCompute, [releasePoiCompute]);

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
    if (!gate.shouldCompute('poi', activeId)) {
      markWaitingForGate();
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
    if (hasEnabledCategories) {
      announcePoiCompute(activeId);
      setPendingCorridorFor(activeId);
    }
  }, [
    activeHasPois,
    activeId,
    announcePoiCompute,
    cancelSearchCorridor,
    currentPoiRouteSignature,
    gate,
    gateRetryNonce,
    markWaitingForGate,
    hasEnabledCategories,
    poiLoading,
    routeBusy,
    setPendingCorridorFor,
    setProjectWithoutHistory,
    storedPoiRouteSignature,
  ]);
}
