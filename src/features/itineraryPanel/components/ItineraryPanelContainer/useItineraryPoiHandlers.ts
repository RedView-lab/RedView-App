import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { translateAppText } from '@/shared/i18n';
import { DEFAULT_POI_PAUSE_MIN, POI_LABELS, type PoiFeature } from '@/features/poi/types';
import type { PredictionResult } from '@/features/fitPredictor';
import {
  buildPoiAutoSortSignature,
  clearPoiAutoSortFavorites,
  computePoiAutoSort,
  FEATURE_TO_PANEL_POI,
  getPoiAutoSortPicks,
  toPoiAutoSortPickRefs,
} from '../../lib/schedule';
import { normalizeItineraryRhythmState } from '../../lib/project';
import type { Itinerary, ItineraryProject, PoiAutoSortSummary } from '../../types';
import { cumulativeRouteLengthsM, projectDistanceAlongRouteM, roundDistanceKm } from '../../lib/routes';
import {
  hasEditableRoute,
  insertWaypointIntoTimeline,
  placeRouteEndpoint,
  setPendingRouteEditForPlacedRow,
  setPendingRoutePatchAfterRemoval,
} from './timelineMutations';
import { removePoiAndLinkedWaypoints } from './poiDraft';
import {
  poiRowPauseMin,
  resolvePoiPauseDefaultMin,
  setPoiFeatureFavorite,
  setPoiFeaturePause,
} from './poiFavoritePause';

const POI_PAUSE_DURATION_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

/** Distance d'un POI le long de la trace de l'itinéraire, en km (null sans trace). */
function projectFeatureDistanceKm(itinerary: Itinerary, feature: PoiFeature): number | null {
  const routePoints = itinerary.gpxRoute?.points ?? [];
  if (routePoints.length < 2 || feature.lat == null || feature.lon == null) return null;
  const distM = projectDistanceAlongRouteM(
    { lat: feature.lat, lon: feature.lon },
    routePoints,
    cumulativeRouteLengthsM(routePoints),
  );
  return distM != null ? roundDistanceKm(distM) : null;
}

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
    const featurePauseMin = feature.pauseDurationMin && feature.pauseDurationMin > 0
      ? feature.pauseDurationMin
      : null;
    if (!itinerary) {
      return {
        favoriteEnabled: Boolean(feature.favorite),
        pauseEnabled: featurePauseMin !== null,
        pauseDurationMin: featurePauseMin ?? DEFAULT_POI_PAUSE_MIN,
      };
    }

    const poiRow = itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
    const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
    // Durée affichée (et posée si l'on coche) : celle du POI, sinon celle de sa catégorie.
    const pauseDurationMin = (poiRow ? poiRowPauseMin(poiRow) : null)
      ?? featurePauseMin
      ?? resolvePoiPauseDefaultMin(itinerary, panelCategory);

    const pauseEnabled = poiRow?.durationMin != null
      ? poiRow.durationMin > 0
      : featurePauseMin !== null;

    return {
      favoriteEnabled: Boolean(poiRow?.favorite ?? feature.favorite),
      autoReason: getPoiAutoSortPicks(itinerary)?.get(feature.id) ?? null,
      pauseEnabled,
      pauseDurationMin,
    };
  }, [activeItineraryRef]);

  /**
   * Favori depuis un popup de la carte : coche et active aussi la pause, à la
   * durée affichée par le popup (`pauseMin`), sinon celle de la catégorie.
   */
  const handlePoiFavoriteToggle = useCallback((feature: PoiFeature, nextEnabled: boolean, pauseMin?: number) => {
    updateActive((it) => {
      setPoiFeatureFavorite(it, feature, nextEnabled, {
        distanceKm: () => projectFeatureDistanceKm(it, feature),
        pauseMin,
      });
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
        placeRouteEndpoint(it, 'start', { lat: feature.lat, lon: feature.lon }, resolvePoiTitle(feature));
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
      placeRouteEndpoint(it, 'end', { lat: feature.lat, lon: feature.lon }, resolvePoiTitle(feature));
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
      setPoiFeaturePause(it, feature, nextEnabled, durationMin, {
        distanceKm: () => projectFeatureDistanceKm(it, feature),
      });
    });
  }, [updateActive]);

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
