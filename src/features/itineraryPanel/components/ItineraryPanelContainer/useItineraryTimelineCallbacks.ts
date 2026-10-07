import { useCallback } from 'react';
import type { TimelineAddItemKind, TimelineAddItemOptions, TimelineView } from '../../types';
import {
  buildTimelineAfterRemoval,
  hasEditableRoute,
  insertTimelineItem,
  moveTimelinePauseItem,
  setPendingRouteEditForPlacedRow,
  setPendingRoutePatchAfterRemoval,
} from './timelineMutations';
import { projectDistanceAlongRouteM } from '../../lib/routes';
import { normalizeItineraryRhythmState } from '../../lib/project';
import { setManualFavoriteOrigin } from './poiFeatureUtils';
import { setPoiRowFavorite, setPoiRowPauseDuration } from './poiFavoritePause';
import type { ItineraryProject } from '../../types';

interface UseItineraryTimelineCallbacksArgs {
  setProject: React.Dispatch<React.SetStateAction<ItineraryProject>>;
  updateActive: (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => void;
  /**
   * Variante de `updateActive` enregistrée dans l'historique undo/redo.
   * Utilisée pour les suppressions (retour `false` = aucun changement).
   */
  updateActiveWithHistory?: (
    mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => boolean | void,
  ) => boolean;
  onSelectAndCenterTimelineRow?: (rowId: string) => void;
}

/**
 * Hook regroupant les callbacks d'actions utilisateur sur la timeline
 * (changement de vue, ajout d'item, pause duration, suppression, favoris, sélection de lieu).
 */
export function useItineraryTimelineCallbacks({
  setProject,
  updateActive,
  updateActiveWithHistory,
  onSelectAndCenterTimelineRow,
}: UseItineraryTimelineCallbacksArgs) {
  const handleChangeTimelineView = useCallback((view: TimelineView) => {
    setProject((p) => ({ ...p, timelineView: view }));
  }, [setProject]);

  const handleAddTimelineItem = useCallback((kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => {
    let createdId: string | null = null;
    updateActive((it) => {
      const added = insertTimelineItem(it.timeline, kind, options);
      if (added) createdId = added.id;
    });
    if (createdId) {
      onSelectAndCenterTimelineRow?.(createdId);
    }
  }, [onSelectAndCenterTimelineRow, updateActive]);

  const handleToggleTimelineItem = useCallback((id: string, visible: boolean) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id);
      if (row) row.visible = visible;
    });
  }, [updateActive]);

  const handleMoveTimelinePause = useCallback((id: string, distanceKm: number) => {
    updateActive((it) => {
      const moved = moveTimelinePauseItem(it.timeline, id, distanceKm);
      if (moved) return;
      it.rhythm = normalizeItineraryRhythmState(it.rhythm);
      if (id.startsWith('poi-pause-')) {
        delete it.rhythm.pausePositionOverridesKm[id];
        return;
      }
      it.rhythm.pausePositionOverridesKm[id] = Math.max(0, Number(distanceKm.toFixed(3)));
    });
  }, [updateActive]);

  /** Durée d'une pause posée, ou de la pause d'un POI (celle de ce POI seul). */
  const handleChangeTimelinePauseDuration = useCallback((id: string, durationMin: number) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id && (item.kind === 'pause' || item.kind === 'poi'));
      if (!row) return;
      if (row.kind === 'poi') {
        setPoiRowPauseDuration(it, row, durationMin);
        return;
      }
      row.durationMin = Math.max(0, Math.round(durationMin));
    });
  }, [updateActive]);

  const handleRemoveTimelineItem = useCallback((id: string) => {
    const applyRemoval = (it: ItineraryProject['itineraries'][number]) => {
      const nextTimeline = buildTimelineAfterRemoval(it.timeline, id, it.gpxRoute?.points);
      if (!nextTimeline) return false;

      const previousTimeline = it.timeline;
      it.timeline = nextTimeline;
      if (hasEditableRoute(it)) {
        setPendingRoutePatchAfterRemoval(it, previousTimeline);
        delete it.pendingTraceExtension;
        delete it.routeAudit;
        it.prediction = null;
      }
      return true;
    };

    if (updateActiveWithHistory) {
      updateActiveWithHistory(applyRemoval);
      return;
    }
    updateActive(applyRemoval);
  }, [updateActive, updateActiveWithHistory]);

  const handleFavoriteTimelineItem = useCallback((id: string, favorite: boolean) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id);
      if (!row) return;
      // Un POI mis en favori prend aussi sa pause (poiFavoritePause.ts).
      if (row.kind === 'poi') {
        setPoiRowFavorite(it, row, favorite);
        return;
      }
      row.favorite = favorite;
      setManualFavoriteOrigin(row, favorite);
    });
  }, [updateActive]);

  const handleSelectTimelinePlace = useCallback((id: string, place: { name: string; lat: number; lon: number }) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id);
      if (!row) return;
      // Nouvelle étape : rien à retirer du tracé, la fenêtre se pose là où elle le rejoint.
      const newlyPlaced = row.lat == null || row.lon == null;
      row.label = place.name;
      row.lat = place.lat;
      row.lon = place.lon;
      if (hasEditableRoute(it)) {
        delete row.onRoute;
        const placedAtM = newlyPlaced
          ? projectDistanceAlongRouteM(place, it.gpxRoute!.points) ?? undefined
          : undefined;
        setPendingRouteEditForPlacedRow(it, id, placedAtM);
        delete it.routeAudit;
        it.prediction = null;
      }
    });
  }, [updateActive]);

  return {
    handleChangeTimelineView,
    handleAddTimelineItem,
    handleToggleTimelineItem,
    handleMoveTimelinePause,
    handleChangeTimelinePauseDuration,
    handleRemoveTimelineItem,
    handleFavoriteTimelineItem,
    handleSelectTimelinePlace,
  };
}
