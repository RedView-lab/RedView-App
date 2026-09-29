import { useCallback, useEffect } from 'react';
import type {
  MapContextMenuActionPayload,
  MapPoiDraftActionPayload,
} from '@/features/map3d';
import { translateAppText } from '@/shared/i18n';
import type { Itinerary, ItineraryProject } from '../../types';
import {
  buildPendingRoutePatchForEditedRow,
  insertTimelineItem,
  insertWaypointIntoTimeline,
} from './timelineMutations';
import { pointInPolygon } from '../../context/ProjectStore/forbiddenZonePatch';
import {
  resolveMapContextPointTitle,
  resolveDraftTitle,
  resolveDraftFeatureId,
  upsertDraftPoiIntoItinerary,
  removePoiAndLinkedWaypoints,
} from './poiDraft';
import { listenItineraryMapAction } from '../../lib/mapActionBridge';
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
  const handleExternalMapContextAction = useCallback((payload: MapContextMenuActionPayload) => {
    switch (payload.action) {
      case 'set-start': {
        const hasItinerary = (project?.itineraries?.length ?? 0) > 0;
        if (!hasItinerary && addItinerary) {
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
            let row = it.timeline.find((item) => item.kind === 'start');
            if (!row) {
              insertTimelineItem(it.timeline, 'start');
              row = it.timeline.find((item) => item.kind === 'start');
            }
            if (!row) return;

            row.label = resolveMapContextPointTitle(payload.point);
            row.lat = payload.point.lat;
            row.lon = payload.point.lng;
            row.distanceKm = 0;
            delete it.routeAudit;
            delete it.pendingTraceExtension;
            it.prediction = null;

            if (it.gpxRoute?.source === 'brouter') {
              it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
            }
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

          delete it.pendingTraceExtension;
          delete it.routeAudit;

          if (it.gpxRoute?.source === 'brouter' && !result.isDirectOnRoute) {
            it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, createdId);
            it.prediction = null;
          }
        });
        if (createdId) {
          onSelectAndCenterTimelineRow?.(createdId);
        }
        break;
      }
      case 'set-finish':
        updateActive((it) => {
          let row = it.timeline.find((item) => item.kind === 'end');
          if (!row) {
            insertTimelineItem(it.timeline, 'end');
            row = it.timeline.find((item) => item.kind === 'end');
          }
          if (!row) return;

          row.label = resolveMapContextPointTitle(payload.point);
          row.lat = payload.point.lat;
          row.lon = payload.point.lng;
          row.distanceKm = null;
          delete it.routeAudit;
          delete it.pendingTraceExtension;
          it.prediction = null;

          if (it.gpxRoute?.source === 'brouter') {
            it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
          }
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
  }, [addItinerary, project?.itineraries?.length, updateActive]);

  const handleExternalPoiDraftAction = useCallback((payload: MapPoiDraftActionPayload) => {
    switch (payload.action) {
      case 'toggle-favorite':
      case 'change-category':
        updateActive((it) => {
          upsertDraftPoiIntoItinerary(it, payload.draft);
        });
        break;
      case 'start-here': {
        const hasItinerary = (project?.itineraries?.length ?? 0) > 0;
        if (!hasItinerary && addItinerary) {
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

            let row = it.timeline.find((item) => item.kind === 'start');
            if (!row) {
              insertTimelineItem(it.timeline, 'start');
              row = it.timeline.find((item) => item.kind === 'start');
            }
            if (!row) return;

            row.label = resolveDraftTitle(payload.draft);
            row.lat = payload.draft.point.lat;
            row.lon = payload.draft.point.lng;
            row.distanceKm = 0;
            delete it.routeAudit;
            delete it.pendingTraceExtension;
            it.prediction = null;

            if (it.gpxRoute?.source === 'brouter') {
              it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
            }
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

          delete it.pendingTraceExtension;
          delete it.routeAudit;

          if (it.gpxRoute?.source === 'brouter' && !result.isDirectOnRoute) {
            it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, createdId);
            it.prediction = null;
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

          let row = it.timeline.find((item) => item.kind === 'end');
          if (!row) {
            insertTimelineItem(it.timeline, 'end');
            row = it.timeline.find((item) => item.kind === 'end');
          }
          if (!row) return;

          row.label = resolveDraftTitle(payload.draft);
          row.lat = payload.draft.point.lat;
          row.lon = payload.draft.point.lng;
          row.distanceKm = null;
          delete it.routeAudit;
          delete it.pendingTraceExtension;
          it.prediction = null;

          if (it.gpxRoute?.source === 'brouter') {
            it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
          }
        });
        break;
      case 'delete': {
        const applyDelete = (it: Itinerary) => {
          const removed = removePoiAndLinkedWaypoints(it, resolveDraftFeatureId(payload.draft));
          delete it.pendingRoutePatch;
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
  }, [addItinerary, project?.itineraries?.length, updateActive, updateActiveWithHistory]);

  useEffect(() => listenItineraryMapAction((detail) => {
    if (detail.kind === 'context-menu') {
      handleExternalMapContextAction(detail.payload);
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
          );
          break;
        case 'toggle-pause':
          poiHandlers.handlePoiPauseToggle(
            detail.feature,
            detail.extra?.nextEnabled ?? false,
            detail.extra?.durationMin ?? 5,
          );
          break;
        case 'toggle-manual-trace':
          poiHandlers.handlePoiManualTraceToggle(
            detail.feature,
            detail.extra?.nextEnabled ?? false,
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
  }), [handleExternalMapContextAction, handleExternalPoiDraftAction, poiHandlers]);

  return {
    handleExternalMapContextAction,
    handleExternalPoiDraftAction,
  };
}
