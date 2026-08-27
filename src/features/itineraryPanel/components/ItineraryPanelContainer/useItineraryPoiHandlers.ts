import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { translateAppText } from '@/shared/i18n';
import { POI_LABELS, type PoiFeature } from '@/features/poi/types';
import { FEATURE_TO_PANEL_POI } from '../../lib/schedule';
import { normalizeItineraryRhythmState } from '../../lib/project';
import type { Itinerary, ItineraryProject } from '../../types';
import {
  buildPendingRoutePatchForEditedRow,
  insertTimelineItem,
} from './timelineMutations';
import { removePoiAndLinkedWaypoints } from './poiDraft';
import { setPoiFeatureFavoriteState } from './poiFeatureUtils';

const POI_PAUSE_DURATION_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

interface UseItineraryPoiHandlersArgs {
  activeItineraryRef: MutableRefObject<Itinerary | null>;
  updateActive: (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => void;
  project?: ItineraryProject;
  addItinerary?: (overrides?: Partial<Itinerary>) => string | null;
}

/**
 * Gère les interactions et mutations de la timeline liées aux points d'intérêt (POIs)
 * (favoris, arrêts/pauses, insertion en étape, suppression).
 */
export function useItineraryPoiHandlers({
  activeItineraryRef,
  updateActive,
  project,
  addItinerary,
}: UseItineraryPoiHandlersArgs) {
  const resolvePoiTitle = useCallback((feature: PoiFeature) => {
    return feature.name?.trim() || POI_LABELS[feature.category] || 'POI';
  }, []);

  const resolvePoiPopupState = useCallback((feature: PoiFeature) => {
    const itinerary = activeItineraryRef.current;
    if (!itinerary) {
      return {
        favoriteEnabled: Boolean(feature.favorite),
        pauseEnabled: false,
        pauseDurationMin: 5,
        manualTraceEnabled: false,
      };
    }

    const poiRow = itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
    const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
    const rhythm = normalizeItineraryRhythmState(itinerary.rhythm);
    const pauseDurationMin = panelCategory
      ? rhythm.poiPauseDurations[panelCategory] ?? 5
      : 5;
    const manualTraceWaypointId = `poi-waypoint-${feature.id}`;

    return {
      favoriteEnabled: Boolean(poiRow?.favorite ?? feature.favorite),
      pauseEnabled: Boolean(
        poiRow
        && poiRow.favorite
        && rhythm.pauseAtFavoritePois
        && pauseDurationMin > 0,
      ),
      pauseDurationMin,
      manualTraceEnabled: itinerary.timeline.some(
        (row) => row.id === manualTraceWaypointId,
      ),
    };
  }, [activeItineraryRef]);

  const handlePoiFavoriteToggle = useCallback((feature: PoiFeature, nextEnabled: boolean) => {
    updateActive((it) => {
      let poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      if (poiRow) {
        poiRow.favorite = nextEnabled;
      } else if (nextEnabled) {
        const endIndex = it.timeline.findIndex((row) => row.kind === 'end');
        const insertAt = endIndex >= 0 ? endIndex : it.timeline.length;
        const panelCategory = FEATURE_TO_PANEL_POI[feature.category];
        poiRow = {
          id: `poi-timeline-${feature.id}`,
          kind: 'poi',
          label: resolvePoiTitle(feature),
          lat: feature.lat,
          lon: feature.lon,
          osmId: feature.id,
          poiCategory: panelCategory,
          favorite: true,
          visible: true,
          distanceKm: null,
        };
        it.timeline.splice(insertAt, 0, poiRow);
      }
      it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, feature.id, nextEnabled);
      if (nextEnabled && (!it.poiFeatures || !it.poiFeatures.some((f) => f.id === feature.id))) {
        if (!it.poiFeatures) it.poiFeatures = [];
        it.poiFeatures.push({ ...feature, favorite: true });
      }
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiStartHere = useCallback((feature: PoiFeature) => {
    const hasItinerary = (project?.itineraries?.length ?? 0) > 0;
    if (!hasItinerary && addItinerary) {
      addItinerary({
        timeline: [
          {
            id: 'start',
            kind: 'start',
            label: resolvePoiTitle(feature),
            lat: feature.lat,
            lon: feature.lon,
            distanceKm: 0,
          },
          {
            id: 'end',
            kind: 'end',
            label: translateAppText('Rechercher un lieu'),
            distanceKm: null,
          },
        ],
      });
    } else {
      updateActive((it) => {
        let row = it.timeline.find((item) => item.kind === 'start');
        if (!row) {
          insertTimelineItem(it.timeline, 'start');
          row = it.timeline.find((item) => item.kind === 'start');
        }
        if (!row) return;

        row.label = resolvePoiTitle(feature);
        row.lat = feature.lat;
        row.lon = feature.lon;
        row.distanceKm = 0;
        delete it.routeAudit;
        delete it.pendingTraceExtension;
        it.prediction = null;

        if (it.gpxRoute?.source === 'brouter') {
          it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
        }
      });
    }
  }, [addItinerary, project?.itineraries?.length, resolvePoiTitle, updateActive]);

  const handlePoiAddWaypoint = useCallback((feature: PoiFeature) => {
    updateActive((it) => {
      const waypointId = `poi-waypoint-${feature.id}`;
      const existingIndex = it.timeline.findIndex((row) => row.id === waypointId);
      if (existingIndex >= 0) return;

      const poiIndex = it.timeline.findIndex((row) => row.kind === 'poi' && row.osmId === feature.id);
      const endIndex = it.timeline.findIndex((row) => row.kind === 'end');
      const anchorRow = poiIndex >= 0 ? it.timeline[poiIndex] : null;
      const insertAt = poiIndex >= 0 ? poiIndex : endIndex >= 0 ? endIndex : it.timeline.length;

      it.timeline.splice(insertAt, 0, {
        id: waypointId,
        kind: 'waypoint',
        label: resolvePoiTitle(feature),
        distanceKm: anchorRow?.distanceKm ?? null,
        lat: feature.lat,
        lon: feature.lon,
        osmId: feature.id,
        visible: true,
      });

      if (!it.poiFeatures) it.poiFeatures = [];
      if (!it.poiFeatures.some((f) => f.id === feature.id)) {
        it.poiFeatures.push(feature);
      }

      delete it.pendingRoutePatch;
      delete it.pendingTraceExtension;
      delete it.routeAudit;
      it.prediction = null;
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiFinishHere = useCallback((feature: PoiFeature) => {
    updateActive((it) => {
      let row = it.timeline.find((item) => item.kind === 'end');
      if (!row) {
        insertTimelineItem(it.timeline, 'end');
        row = it.timeline.find((item) => item.kind === 'end');
      }
      if (!row) return;

      row.label = resolvePoiTitle(feature);
      row.lat = feature.lat;
      row.lon = feature.lon;
      row.distanceKm = null;
      delete it.routeAudit;
      delete it.pendingTraceExtension;
      it.prediction = null;

      if (it.gpxRoute?.source === 'brouter') {
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
      }
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiCyclePauseDuration = useCallback((feature: PoiFeature) => {
    updateActive((it) => {
      const poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
      if (!panelCategory) return;

      const rhythm = normalizeItineraryRhythmState(it.rhythm);
      it.rhythm = rhythm;
      const current = rhythm.poiPauseDurations[panelCategory] ?? POI_PAUSE_DURATION_STEPS[0];
      const currentIndex = POI_PAUSE_DURATION_STEPS.findIndex((value) => value === current);
      const nextDuration = POI_PAUSE_DURATION_STEPS[(currentIndex + 1) % POI_PAUSE_DURATION_STEPS.length] ?? POI_PAUSE_DURATION_STEPS[0];
      rhythm.poiPauseDurations[panelCategory] = nextDuration;
    });
  }, [updateActive]);

  const handlePoiPauseToggle = useCallback((
    feature: PoiFeature,
    nextEnabled: boolean,
    durationMin: number,
  ) => {
    updateActive((it) => {
      const poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      if (!poiRow) return;

      const rhythm = normalizeItineraryRhythmState(it.rhythm);
      it.rhythm = rhythm;
      poiRow.favorite = nextEnabled;
      it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, feature.id, nextEnabled);

      if (!nextEnabled) {
        return;
      }

      rhythm.pauseAtFavoritePois = true;
      const panelCategory = poiRow.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
      if (!panelCategory) return;

      const currentDuration = rhythm.poiPauseDurations[panelCategory];
      if (currentDuration == null || currentDuration <= 0) {
        rhythm.poiPauseDurations[panelCategory] = Math.max(1, Math.round(durationMin));
      }
    });
  }, [updateActive]);

  const handlePoiManualTraceToggle = useCallback((feature: PoiFeature, nextEnabled: boolean) => {
    updateActive((it) => {
      const waypointId = `poi-waypoint-${feature.id}`;
      const existingIndex = it.timeline.findIndex((row) => row.id === waypointId);

      if (nextEnabled) {
        if (existingIndex >= 0) return;

        const poiIndex = it.timeline.findIndex((row) => row.kind === 'poi' && row.osmId === feature.id);
        const endIndex = it.timeline.findIndex((row) => row.kind === 'end');
        const anchorRow = poiIndex >= 0 ? it.timeline[poiIndex] : null;
        const insertAt = poiIndex >= 0 ? poiIndex : endIndex >= 0 ? endIndex : it.timeline.length;

        it.timeline.splice(insertAt, 0, {
          id: waypointId,
          kind: 'waypoint',
          label: resolvePoiTitle(feature),
          distanceKm: anchorRow?.distanceKm ?? null,
          lat: feature.lat,
          lon: feature.lon,
          osmId: feature.id,
          visible: true,
        });
      } else {
        if (existingIndex < 0) return;
        it.timeline.splice(existingIndex, 1);
      }

      delete it.pendingRoutePatch;
      delete it.pendingTraceExtension;
      delete it.routeAudit;
      it.prediction = null;
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiStreetView = useCallback((feature: PoiFeature) => {
    if (typeof window === 'undefined') return;
    const url = new URL('https://www.google.com/maps/@');
    url.searchParams.set('api', '1');
    url.searchParams.set('map_action', 'pano');
    url.searchParams.set('viewpoint', `${feature.lat},${feature.lon}`);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }, []);

  const handlePoiSelectPauseDuration = useCallback((feature: PoiFeature, durationMin: number) => {
    updateActive((it) => {
      const poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
      if (!panelCategory) return;

      const rhythm = normalizeItineraryRhythmState(it.rhythm);
      it.rhythm = rhythm;
      rhythm.poiPauseDurations[panelCategory] = Math.max(1, Math.round(durationMin));
    });
  }, [updateActive]);

  const handlePoiDelete = useCallback((feature: PoiFeature) => {
    updateActive((it) => {
      removePoiAndLinkedWaypoints(it, feature.id);
      delete it.pendingRoutePatch;
      delete it.pendingTraceExtension;
      delete it.routeAudit;
      it.prediction = null;
    });
  }, [updateActive]);

  return {
    resolvePoiPopupState,
    handlePoiFavoriteToggle,
    handlePoiStartHere,
    handlePoiAddWaypoint,
    handlePoiFinishHere,
    handlePoiCyclePauseDuration,
    handlePoiSelectPauseDuration,
    handlePoiPauseToggle,
    handlePoiManualTraceToggle,
    handlePoiStreetView,
    handlePoiDelete,
  };
}
