import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { translateAppText } from '@/shared/i18n';
import { POI_LABELS, type PoiFeature } from '@/features/poi/types';
import type { PredictionResult } from '@/features/fitPredictor';
import {
  buildPoiAutoSortSignature,
  clearPoiAutoSortFavorites,
  computePoiAutoSort,
  FEATURE_TO_PANEL_POI,
  getPoiAutoSortPicks,
  toPoiAutoSortPickRefs,
  upsertPoiTimelineRow,
} from '../../lib/schedule';
import { normalizeItineraryRhythmState } from '../../lib/project';
import type { Itinerary, ItineraryProject, PoiAutoSortSummary } from '../../types';
import { cumulativeRouteLengthsM, projectDistanceAlongRouteM, roundDistanceKm } from '../../lib/routes';
import {
  buildPendingRoutePatchForEditedRow,
  hasEditableRoute,
  insertTimelineItem,
  insertWaypointIntoTimeline,
  setPendingRouteEditForPlacedRow,
  setPendingRoutePatchAfterRemoval,
} from './timelineMutations';
import { removePoiAndLinkedWaypoints } from './poiDraft';
import { setManualFavoriteOrigin, setPoiFeatureFavoriteState } from './poiFeatureUtils';

const POI_PAUSE_DURATION_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

interface UseItineraryPoiHandlersArgs {
  activeItineraryRef: MutableRefObject<Itinerary | null>;
  updateActive: (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => void;
  /**
   * Variante de `updateActive` qui enregistre la mutation dans l'historique
   * undo/redo. Le mutateur peut retourner `false` pour signaler une absence
   * de changement (aucune entrée d'historique créée).
   */
  updateActiveWithHistory?: (
    mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => boolean | void,
  ) => boolean;
  project?: ItineraryProject;
  addItinerary?: (overrides?: Partial<Itinerary>) => string | null;
  onSelectAndCenterTimelineRow?: (rowId: string) => void;
  /** Prédiction la plus récente (store) ; à défaut `itinerary.prediction`. */
  getPrediction?: (itinerary: Itinerary) => PredictionResult | null | undefined;
}

/**
 * Gère les interactions et mutations de la timeline liées aux points d'intérêt (POIs)
 * (favoris, arrêts/pauses, insertion en étape, suppression).
 */
export function useItineraryPoiHandlers({
  activeItineraryRef,
  updateActive,
  updateActiveWithHistory,
  project,
  addItinerary,
  onSelectAndCenterTimelineRow,
  getPrediction,
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
      };
    }

    const poiRow = itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
    const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
    const rhythm = normalizeItineraryRhythmState(itinerary.rhythm);
    const pauseDurationMin =
      poiRow?.durationMin
      ?? (feature.pauseDurationMin && feature.pauseDurationMin > 0 ? feature.pauseDurationMin : undefined)
      ?? (panelCategory ? rhythm.poiPauseDurations[panelCategory] : undefined)
      ?? 5;

    const pauseEnabled = poiRow?.durationMin != null
      ? poiRow.durationMin > 0
      : Boolean(feature.pauseDurationMin && feature.pauseDurationMin > 0);

    return {
      favoriteEnabled: Boolean(poiRow?.favorite ?? feature.favorite),
      autoReason: getPoiAutoSortPicks(itinerary)?.get(feature.id) ?? null,
      pauseEnabled,
      pauseDurationMin,
    };
  }, [activeItineraryRef]);

  const handlePoiFavoriteToggle = useCallback((feature: PoiFeature, nextEnabled: boolean) => {
    updateActive((it) => {
      const routePoints = it.gpxRoute?.points ?? [];
      const cumLengths = routePoints.length >= 2 ? cumulativeRouteLengthsM(routePoints) : null;
      const calcDistanceKm = (): number | null => {
        if (routePoints.length >= 2 && cumLengths && feature.lat != null && feature.lon != null) {
          const distM = projectDistanceAlongRouteM({ lat: feature.lat, lon: feature.lon }, routePoints, cumLengths);
          if (distM != null) return roundDistanceKm(distM);
        }
        return null;
      };

      const hasRow = it.timeline.some((row) => row.kind === 'poi' && row.osmId === feature.id);
      if (hasRow || nextEnabled) {
        const poiRow = upsertPoiTimelineRow(it, feature, calcDistanceKm);
        poiRow.favorite = nextEnabled;
        setManualFavoriteOrigin(poiRow, nextEnabled);
      }
      it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, feature.id, nextEnabled);
      if (nextEnabled && (!it.poiFeatures || !it.poiFeatures.some((f) => f.id === feature.id))) {
        if (!it.poiFeatures) it.poiFeatures = [];
        it.poiFeatures.push({ ...feature, favorite: true, favoriteSource: 'manual' });
      }
    });
  }, [updateActive]);

  /**
   * Tri automatique : calcule les POI à garder dans la feuille de route (les
   * favoris y restent toujours) et renvoie la mutation qui enregistre ce
   * filtre, ou null si rien n'est triable (pas de trace / de POI).
   */
  const buildPoiAutoSortMutation = useCallback((itinerary: Itinerary) => {
    const prediction = getPrediction?.(itinerary) ?? itinerary.prediction ?? null;
    const run = computePoiAutoSort(itinerary, prediction);
    if (!run) return null;

    const summary: PoiAutoSortSummary = {
      total: run.result.picks.length,
      byReason: run.result.stats.byReason,
      warnings: run.result.warnings,
      usedPrediction: run.usedPrediction,
    };
    const signature = buildPoiAutoSortSignature(itinerary, prediction);
    const picks = toPoiAutoSortPickRefs(run);
    return (it: Itinerary) => {
      // Les tris d'avant le filtrage posaient des favoris « auto ».
      clearPoiAutoSortFavorites(it);
      it.poiAutoSort = { signature, summary, picks, ranAt: new Date().toISOString() };
    };
  }, [getPrediction]);

  /**
   * Toggle « Affiner les résultats » : activé, trie tout de suite si des POI
   * sont chargés (sinon au prochain chargement) ; désactivé, la feuille de
   * route retrouve tous les POI. Une seule entrée d'historique, donc
   * annulable d'un coup.
   */
  const handleTogglePoiAutoSort = useCallback((enabled: boolean) => {
    const itinerary = activeItineraryRef.current;
    if (!itinerary) return;
    const sort = enabled ? buildPoiAutoSortMutation(itinerary) : null;
    const apply = (it: Itinerary) => {
      if (enabled) {
        it.poiAutoSortEnabled = true;
        sort?.(it);
        return;
      }
      delete it.poiAutoSortEnabled;
      clearPoiAutoSortFavorites(it);
      delete it.poiAutoSort;
    };
    if (updateActiveWithHistory) updateActiveWithHistory(apply);
    else updateActive(apply);
  }, [activeItineraryRef, buildPoiAutoSortMutation, updateActive, updateActiveWithHistory]);

  /**
   * Re-tri quand le toggle est actif et que les entrées du dernier tri ont
   * changé (POI rechargés, départ, prédiction…). Hors historique : c'est la
   * conséquence d'une action déjà annulable. Renvoie false si rien n'a été trié.
   */
  const refreshPoiAutoSort = useCallback((): boolean => {
    const itinerary = activeItineraryRef.current;
    if (!itinerary?.poiAutoSortEnabled) return false;
    const sort = buildPoiAutoSortMutation(itinerary);
    if (!sort) return false;
    updateActive(sort);
    return true;
  }, [activeItineraryRef, buildPoiAutoSortMutation, updateActive]);

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

        if (hasEditableRoute(it)) {
          it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it, row.id);
        }
      });
    }
  }, [addItinerary, project?.itineraries?.length, resolvePoiTitle, updateActive]);

  const handlePoiAddWaypoint = useCallback((feature: PoiFeature) => {
    let createdId: string | null = null;
    updateActive((it) => {
      const waypointId = `poi-waypoint-${feature.id}`;
      const result = insertWaypointIntoTimeline(
        it.timeline,
        { lat: feature.lat, lon: feature.lon },
        it.gpxRoute?.points,
        {
          id: waypointId,
          label: resolvePoiTitle(feature),
          osmId: feature.id,
          poiCategory: FEATURE_TO_PANEL_POI[feature.category],
        },
      );
      createdId = result.newRow.id;

      if (!it.poiFeatures) it.poiFeatures = [];
      if (!it.poiFeatures.some((f) => f.id === feature.id)) {
        it.poiFeatures.push(feature);
      }

      delete it.routeAudit;

      if (hasEditableRoute(it) && !result.isDirectOnRoute) {
        setPendingRouteEditForPlacedRow(it, createdId);
        it.prediction = null;
      } else {
        delete it.pendingTraceExtension;
      }
    });
    if (createdId) {
      onSelectAndCenterTimelineRow?.(createdId);
    }
  }, [onSelectAndCenterTimelineRow, resolvePoiTitle, updateActive]);

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

      if (hasEditableRoute(it)) {
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it, row.id);
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
      let poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      if (!poiRow && nextEnabled) {
        handlePoiFavoriteToggle(feature, true);
        poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      }
      if (poiRow) {
        poiRow.durationMin = nextEnabled ? Math.max(1, Math.round(durationMin)) : undefined;
      }

      const currentFavorite = Boolean(poiRow?.favorite ?? feature.favorite);
      it.poiFeatures = setPoiFeatureFavoriteState(
        it.poiFeatures,
        feature.id,
        currentFavorite,
        nextEnabled ? Math.max(1, Math.round(durationMin)) : null,
      );

      if (!nextEnabled) {
        return;
      }

      const rhythm = normalizeItineraryRhythmState(it.rhythm);
      it.rhythm = rhythm;
      const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
      if (!panelCategory) return;

      const currentDuration = rhythm.poiPauseDurations[panelCategory];
      if (currentDuration == null || currentDuration <= 0) {
        rhythm.poiPauseDurations[panelCategory] = Math.max(1, Math.round(durationMin));
      }
    });
  }, [handlePoiFavoriteToggle, updateActive]);

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
    const applyDelete = (it: Itinerary) => {
      const previousTimeline = it.timeline;
      const removed = removePoiAndLinkedWaypoints(it, feature.id);
      setPendingRoutePatchAfterRemoval(it, previousTimeline);
      delete it.pendingTraceExtension;
      delete it.routeAudit;
      it.prediction = null;
      return removed;
    };

    if (updateActiveWithHistory) {
      updateActiveWithHistory(applyDelete);
      return;
    }
    updateActive(applyDelete);
  }, [updateActive, updateActiveWithHistory]);

  return {
    resolvePoiPopupState,
    handlePoiFavoriteToggle,
    handleTogglePoiAutoSort,
    refreshPoiAutoSort,
    handlePoiStartHere,
    handlePoiAddWaypoint,
    handlePoiFinishHere,
    handlePoiCyclePauseDuration,
    handlePoiSelectPauseDuration,
    handlePoiPauseToggle,
    handlePoiStreetView,
    handlePoiDelete,
  };
}
