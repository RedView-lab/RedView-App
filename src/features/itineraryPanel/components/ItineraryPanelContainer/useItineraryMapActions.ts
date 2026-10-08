import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useCallback, useEffect } from 'react';
import type {
  MapContextMenuActionPayload,
  MapPoiDraftActionPayload,
} from '@/features/map3d';
import { translateAppText } from '@/shared/i18n';
import type { Itinerary, ItineraryProject } from '../../types';
import { insertTimelineItem, insertWaypointIntoTimeline } from './timelineMutations';
import {
  hasEditableRoute,
  setPendingRouteEditForPlacedRow,
  setPendingRoutePatchAfterRemoval,
} from './timelineRoutePatch';
import { placeRouteEndpoint } from './routeEndpointPlacement';
import { pointInPolygon } from '../../context/ProjectStore/forbiddenZonePatch';
import {
  resolveMapContextPointTitle,
  resolveDraftTitle,
  resolveDraftFeatureId,
  upsertDraftPoiIntoItinerary,
  removePoiAndLinkedWaypoints,
} from './poiDraft';
import { listenItineraryMapAction, type RoutePointAddPayload } from '../../lib/mapActionBridge';
import type { useItineraryPoiHandlers } from './useItineraryPoiHandlers';

interface UseItineraryMapActionsArgs {
  updateActive: (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => void;
  /**
   * Variante de `updateActive` enregistrée dans l'historique undo/redo.
   * Utilisée pour les suppressions (retour `false` = aucun changement).
   */
  updateActiveWithHistory?: (
    mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => boolean | void,
  ) => boolean;
  poiHandlers?: ReturnType<typeof useItineraryPoiHandlers>;
  project?: ItineraryProject;
  addItinerary?: (overrides?: Partial<Itinerary>) => string | null;
  onSelectAndCenterTimelineRow?: (rowId: string) => void;
}

/**
 * Gère les actions provenant de la carte 3D (menu contextuel du clic droit, draft POI et actions POI directes)
 * et les applique sur l'itinéraire actif.
 */
export function useItineraryMapActions({
  updateActive,
  updateActiveWithHistory,
  poiHandlers,
  project,
  addItinerary,
  onSelectAndCenterTimelineRow,
}: UseItineraryMapActionsArgs) {
  // Valeurs lues par les gestionnaires : leurs seules dépendances au projet.
  const itineraryCount = project?.itineraries?.length ?? 0;
  const activeItineraryId = project?.activeItineraryId;
  const handleExternalMapContextAction = useCallback((payload: MapContextMenuActionPayload) => {
    trackAnalyticsEvent({ name: 'context_menu_action', data: { action: payload.action } });
    switch (payload.action) {
      case 'set-start': {
        const hasItinerary = itineraryCount > 0;
        if (!hasItinerary && addItinerary) {
          trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'map' } });
          addItinerary({
            timeline: [
              {
                id: 'start',
                kind: 'start',
                label: resolveMapContextPointTitle(payload.point),
                lat: payload.point.lat,
                lon: payload.point.lng,
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
            placeRouteEndpoint(
              it,
              'start',
              { lat: payload.point.lat, lon: payload.point.lng },
              resolveMapContextPointTitle(payload.point),
              { pickToleranceM: payload.point.pickToleranceM },
            );
          });
        }
        break;
      }
      case 'add-waypoint': {
        let createdId: string | null = null;
        updateActive((it) => {
          const result = insertWaypointIntoTimeline(
            it.timeline,
            { lat: payload.point.lat, lon: payload.point.lng },
            it.gpxRoute?.points,
            {
              label: resolveMapContextPointTitle(payload.point),
            },
          );
          createdId = result.newRow.id;

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
        break;
      }
      case 'set-finish':
        updateActive((it) => {
          placeRouteEndpoint(
            it,
            'end',
            { lat: payload.point.lat, lon: payload.point.lng },
            resolveMapContextPointTitle(payload.point),
            { pickToleranceM: payload.point.pickToleranceM },
          );
        });
        break;
      case 'delete-forbidden-zone':
        updateActive((it) => {
          const zoneId = payload.point.forbiddenZoneId;
          const lat = payload.point.lat;
          const lon = payload.point.lng;
          const existingZones = it.forbiddenZones ?? [];
          const filtered = existingZones.filter((zone) => {
            if (zoneId && zoneId !== 'forbidden-zone' && zone.id === zoneId) return false;
            if (pointInPolygon({ lat, lon }, zone.points)) return false;
            return true;
          });
          it.forbiddenZones = filtered.length > 0 ? filtered : undefined;
          delete it.pendingRoutePatch;
          delete it.pendingTraceExtension;
          delete it.routeAudit;
          it.prediction = null;
        });
        break;
      default:
        break;
    }
  }, [addItinerary, itineraryCount, onSelectAndCenterTimelineRow, updateActive]);

  const handleExternalPoiDraftAction = useCallback((payload: MapPoiDraftActionPayload) => {
    switch (payload.action) {
      case 'toggle-favorite':
      case 'change-category':
        updateActive((it) => {
          upsertDraftPoiIntoItinerary(it, payload.draft);
        });
        break;
      case 'start-here': {
        const hasItinerary = itineraryCount > 0;
        if (!hasItinerary && addItinerary) {
          trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'map' } });
          addItinerary({
            timeline: [
              {
                id: 'start',
                kind: 'start',
                label: resolveDraftTitle(payload.draft),
                lat: payload.draft.point.lat,
                lon: payload.draft.point.lng,
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
            upsertDraftPoiIntoItinerary(it, payload.draft);
            placeRouteEndpoint(
              it,
              'start',
              { lat: payload.draft.point.lat, lon: payload.draft.point.lng },
              resolveDraftTitle(payload.draft),
            );
          });
        }
        break;
      }
      case 'add-waypoint': {
        let createdId: string | null = null;
        updateActive((it) => {
          const poiId = upsertDraftPoiIntoItinerary(it, payload.draft);
          const waypointId = poiId != null ? `poi-waypoint-${poiId}` : `draft-waypoint-${payload.draft.id}`;
          const result = insertWaypointIntoTimeline(
            it.timeline,
            { lat: payload.draft.point.lat, lon: payload.draft.point.lng },
            it.gpxRoute?.points,
            {
              id: waypointId,
              label: resolveDraftTitle(payload.draft),
              osmId: poiId ?? undefined,
            },
          );
          createdId = result.newRow.id;

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
        break;
      }
      case 'finish-here':
        updateActive((it) => {
          upsertDraftPoiIntoItinerary(it, payload.draft);
          placeRouteEndpoint(
            it,
            'end',
            { lat: payload.draft.point.lat, lon: payload.draft.point.lng },
            resolveDraftTitle(payload.draft),
          );
        });
        break;
      case 'delete': {
        const applyDelete = (it: Itinerary) => {
          const previousTimeline = it.timeline;
          const removed = removePoiAndLinkedWaypoints(it, resolveDraftFeatureId(payload.draft));
          setPendingRoutePatchAfterRemoval(it, previousTimeline);
          delete it.pendingTraceExtension;
          delete it.routeAudit;
          it.prediction = null;
          return removed;
        };

        if (updateActiveWithHistory) {
          updateActiveWithHistory(applyDelete);
          break;
        }
        updateActive(applyDelete);
        break;
      }
      default:
        break;
    }
  }, [addItinerary, itineraryCount, onSelectAndCenterTimelineRow, updateActive, updateActiveWithHistory]);

  // Point placed on the active route from the analysis chart: it lies on the
  // trace, so a step adds a row without rerouting; start / finish move like
  // « Démarrer ici » / « Finir ici ».
  const handleRoutePointAdd = useCallback((payload: RoutePointAddPayload) => {
    if (payload.itineraryId !== activeItineraryId) return;
    const point = { lat: payload.lat, lon: payload.lon };
    let createdId: string | null = null;
    updateActive((it) => {
      switch (payload.kind) {
        case 'pause':
          createdId = insertTimelineItem(it.timeline, 'pause', { distanceKm: payload.distanceM / 1_000 })?.id ?? null;
          break;
        case 'step':
        case 'waypoint': {
          const result = insertWaypointIntoTimeline(it.timeline, point, it.gpxRoute?.points, {
            label: payload.label,
            routeDistanceM: payload.distanceM,
          });
          createdId = result.newRow.id;
          delete it.routeAudit;
          delete it.pendingTraceExtension;
          break;
        }
        case 'start':
        case 'end':
          createdId = placeRouteEndpoint(it, payload.kind, point, payload.label, {
            routeDistanceM: payload.distanceM,
          })?.id ?? null;
          break;
        default:
          break;
      }
    });
    if (createdId) {
      onSelectAndCenterTimelineRow?.(createdId);
    }
  }, [activeItineraryId, onSelectAndCenterTimelineRow, updateActive]);

  useEffect(() => listenItineraryMapAction((detail) => {
    if (detail.kind === 'context-menu') {
      handleExternalMapContextAction(detail.payload);
      return;
    }

    if (detail.kind === 'route-point-add') {
      handleRoutePointAdd(detail.payload);
      return;
    }

    if (detail.kind === 'poi-draft') {
      handleExternalPoiDraftAction(detail.payload);
      return;
    }

    if (detail.kind === 'poi-action' && poiHandlers) {
      switch (detail.action) {
        case 'start-here':
          poiHandlers.handlePoiStartHere(detail.feature);
          break;
        case 'add-waypoint':
          poiHandlers.handlePoiAddWaypoint(detail.feature);
          break;
        case 'finish-here':
          poiHandlers.handlePoiFinishHere(detail.feature);
          break;
        case 'delete':
          poiHandlers.handlePoiDelete(detail.feature);
          break;
        case 'toggle-favorite':
          poiHandlers.handlePoiFavoriteToggle(
            detail.feature,
            detail.extra?.nextEnabled ?? false,
            detail.extra?.durationMin,
          );
          break;
        case 'toggle-pause':
          poiHandlers.handlePoiPauseToggle(
            detail.feature,
            detail.extra?.nextEnabled ?? false,
            detail.extra?.durationMin ?? 5,
          );
          break;
        case 'set-pause-duration':
          poiHandlers.handlePoiSelectPauseDuration(
            detail.feature,
            detail.extra?.durationMin ?? 5,
          );
          break;
        case 'cycle-pause-duration':
          poiHandlers.handlePoiCyclePauseDuration(detail.feature);
          break;
        default:
          break;
      }
    }
  }), [handleExternalMapContextAction, handleExternalPoiDraftAction, handleRoutePointAdd, poiHandlers]);

  return {
    handleExternalMapContextAction,
    handleExternalPoiDraftAction,
  };
}
