import { useCallback } from 'react';
import type { TimelineAddItemKind, TimelineAddItemOptions, TimelineView } from '../../types';
import {
  buildPendingRoutePatchAfterRemoval,
  buildPendingRoutePatchForEditedRow,
  buildTimelineAfterRemoval,
  insertTimelineItem,
  moveTimelinePauseItem,
} from './timelineMutations';
import { normalizeItineraryRhythmState } from '../../lib/project';
import { resolveFavoritePoiPauseDurationMin } from '../../sections/timeline/TimelineTimelineView/utilsParts/schedule-stops';
import { setPoiFeatureFavoriteState } from './poiFeatureUtils';
import type { ItineraryProject } from '../../types';

interface UseItineraryTimelineCallbacksArgs {
  setProject: React.Dispatch<React.SetStateAction<ItineraryProject>>;
  updateActive: (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => void;
}

/**
 * Hook regroupant les callbacks d'actions utilisateur sur la timeline
 * (changement de vue, ajout d'item, pause duration, suppression, favoris, sélection de lieu).
 */
export function useItineraryTimelineCallbacks({
  setProject,
  updateActive,
}: UseItineraryTimelineCallbacksArgs) {
  const handleChangeTimelineView = useCallback((view: TimelineView) => {
    setProject((p) => ({ ...p, timelineView: view }));
  }, [setProject]);

  const handleAddTimelineItem = useCallback((kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => {
    updateActive((it) => {
      insertTimelineItem(it.timeline, kind, options);
    });
  }, [updateActive]);

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

  const handleChangeTimelinePauseDuration = useCallback((id: string, durationMin: number) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id && item.kind === 'pause');
      if (!row) return;
      row.durationMin = Math.max(0, Math.round(durationMin));
    });
  }, [updateActive]);

  const handleRemoveTimelineItem = useCallback((id: string) => {
    updateActive((it) => {
      const removedIndex = it.timeline.findIndex((item) => item.id === id);
      const removedRow = removedIndex >= 0 ? it.timeline[removedIndex] : null;
      const nextTimeline = buildTimelineAfterRemoval(it.timeline, id);
      if (!nextTimeline) return;

      it.timeline = nextTimeline;
      if (it.gpxRoute?.source === 'brouter') {
        it.pendingRoutePatch = buildPendingRoutePatchAfterRemoval(
          nextTimeline,
          removedIndex,
          removedRow,
        );
        delete it.pendingTraceExtension;
        delete it.routeAudit;
        it.prediction = null;
      }
    });
  }, [updateActive]);

  const handleFavoriteTimelineItem = useCallback((id: string, favorite: boolean) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id);
      if (!row) return;

      const hasAutomaticFavoritePause =
        !favorite && resolveFavoritePoiPauseDurationMin(row, it.rhythm) > 0;
      if (hasAutomaticFavoritePause) return;

      row.favorite = favorite;
      if (row.kind === 'poi' && row.osmId != null) {
        it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, row.osmId, favorite);
      }
    });
  }, [updateActive]);

  const handleSelectTimelinePlace = useCallback((id: string, place: { name: string; lat: number; lon: number }) => {
    updateActive((it) => {
      const row = it.timeline.find((item) => item.id === id);
      if (!row) return;
      row.label = place.name;
      row.lat = place.lat;
      row.lon = place.lon;
      if (it.gpxRoute?.source === 'brouter') {
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, id);
        delete it.pendingTraceExtension;
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
