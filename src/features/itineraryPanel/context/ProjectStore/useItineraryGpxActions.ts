import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { translateAppText } from '@/shared/i18n';
import { routeLengthM } from '@/features/poi/lib/gpx-loader';
import {
  cleanGpxGlitches,
  cumulativeRouteLengthsM,
  roundDistanceKm,
} from '../../lib/routes';
import {
  mergeItineraryProject,
  type MergeItineraryConnectorSegment,
} from '../../lib/project';
import { reverseItineraryGpxProject } from '../../lib/project';
import { splitItineraryProject } from '../../lib/project';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromPoints,
} from '../../lib/route-metrics';
import {
  buildPendingRoutePatchForForbiddenZone,
  pointInPolygon,
} from './forbiddenZonePatch';
import { applyTraceAppend, resolveTraceAppendKind } from '../../lib/tracer/traceEdits';
import type {
  ItineraryForbiddenZone,
  ItineraryProject,
} from '../../types';
import type { TraceHistoryEntry } from './types';
import { createDocumentId } from '../../lib/project/ids';

interface UseItineraryGpxActionsArgs {
  projectRef: MutableRefObject<ItineraryProject>;
  updateItinerary: (id: string, mut: (draft: ItineraryProject['itineraries'][number]) => void) => void;
  pushTraceHistoryEntry: (entry: TraceHistoryEntry, options?: { pendingTraceAppend?: boolean }) => void;
  pushTraceHistoryEntries: (entries: TraceHistoryEntry[]) => void;
}

/**
 * Gère les transformations avancées de traces GPX et les zones interdites
 * (inversion, ajout de points, simplification, zones interdites, fusion, scission).
 */
export function useItineraryGpxActions({
  projectRef,
  updateItinerary,
  pushTraceHistoryEntry,
  pushTraceHistoryEntries,
}: UseItineraryGpxActionsArgs) {
  const reverseItineraryGpx = useCallback(
    (id: string) => {
      const currentProject = projectRef.current;
      const nextProject = reverseItineraryGpxProject(currentProject, id);
      if (!nextProject) return false;

      const entry: TraceHistoryEntry = {
        itineraryId: id,
        before: currentProject,
        after: nextProject,
      };
      pushTraceHistoryEntry(entry);
      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const appendTracePoint = useCallback(
    (
      id: string,
      point: { lat: number; lon: number; label: string },
    ) => {
      const currentProject = projectRef.current;
      const itinerary = currentProject.itineraries.find((it) => it.id === id);
      if (!itinerary) return false;

      const pointKind = resolveTraceAppendKind(itinerary);
      if (!pointKind) return false;

      const nextProject: ItineraryProject = {
        ...currentProject,
        itineraries: currentProject.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          applyTraceAppend(copy, point);
          return copy;
        }),
      };

      const entry: TraceHistoryEntry = {
        itineraryId: id,
        before: currentProject,
        after: nextProject,
      };

      // Prolongement routé par BRouter : l'étape reste « en attente » pour que
      // le routage puisse l'annuler proprement s'il échoue (point non routable).
      pushTraceHistoryEntry(entry, { pendingTraceAppend: pointKind === 'waypoint' });

      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const addForbiddenZone = useCallback(
    (id: string, points: Array<{ lat: number; lon: number }>) => {
      if (points.length < 3) return null;

      const currentProject = projectRef.current;
      const itinerary = currentProject.itineraries.find((it) => it.id === id);
      if (!itinerary) return null;

      const zone: ItineraryForbiddenZone = {
        id: createDocumentId('fz'),
        points: points.map((point) => ({ lat: point.lat, lon: point.lon })),
        createdAt: new Date().toISOString(),
      };

      const entries: TraceHistoryEntry[] = [];
      let workingProject = currentProject;

      for (let pointCount = 3; pointCount <= zone.points.length; pointCount += 1) {
        const partialZone: ItineraryForbiddenZone = {
          ...zone,
          points: zone.points.slice(0, pointCount),
        };
        const nextProject: ItineraryProject = {
          ...workingProject,
          itineraries: workingProject.itineraries.map((it) => {
            if (it.id !== id) return it;
            const copy = structuredClone(it);
            const existingZones = copy.forbiddenZones ?? [];
            const withoutCurrentZone = existingZones.filter((existing) => existing.id !== zone.id);
            copy.forbiddenZones = [...withoutCurrentZone, partialZone];
            // Tracé BRouter ou GPX importé : la traversée de la zone est recalculée.
            const routePoints = copy.gpxRoute?.points;
            if (routePoints && routePoints.length >= 2) {
              copy.pendingRoutePatch = buildPendingRoutePatchForForbiddenZone(
                copy.timeline,
                routePoints,
                partialZone,
              );
            }
            delete copy.routeAudit;
            copy.prediction = null;
            return copy;
          }),
        };

        entries.push({
          itineraryId: id,
          before: workingProject,
          after: nextProject,
        });
        workingProject = nextProject;
      }

      pushTraceHistoryEntries(entries);
      return zone;
    },
    [projectRef, pushTraceHistoryEntries],
  );

  const removeForbiddenZone = useCallback(
    (id: string, options?: { zoneId?: string; point?: { lat: number; lon: number } }) => {
      const currentProject = projectRef.current;
      const itinerary = currentProject.itineraries.find((it) => it.id === id);
      if (!itinerary) return false;

      const existingZones = itinerary.forbiddenZones ?? [];
      if (existingZones.length === 0) return false;

      const zoneId = options?.zoneId;
      const point = options?.point;

      const filtered = existingZones.filter((zone) => {
        if (zoneId && zone.id === zoneId) return false;
        if (point && pointInPolygon(point, zone.points)) return false;
        return true;
      });

      if (filtered.length === existingZones.length) return false;

      const nextProject: ItineraryProject = {
        ...currentProject,
        itineraries: currentProject.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          copy.forbiddenZones = filtered.length > 0 ? filtered : undefined;
          delete copy.pendingRoutePatch;
          delete copy.pendingTraceExtension;
          delete copy.routeAudit;
          copy.prediction = null;
          return copy;
        }),
      };

      const entry: TraceHistoryEntry = {
        itineraryId: id,
        before: currentProject,
        after: nextProject,
      };
      pushTraceHistoryEntry(entry);
      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const cleanItineraryGpxGlitches = useCallback(
    (id: string) => {
      updateItinerary(id, (it) => {
        const route = it.gpxRoute;
        if (!route || route.source === 'brouter') return;

        const cleanedPoints = cleanGpxGlitches(route.points);
        const geometryUnchanged =
          cleanedPoints.length === route.points.length &&
          cleanedPoints.every((point, index) => {
            const current = route.points[index];
            return (
              point.lat === current?.lat &&
              point.lon === current.lon &&
              point.distanceM === current.distanceM &&
              point.elevationM === current.elevationM &&
              point.surface === current.surface
            );
          });
        if (geometryUnchanged) return;

        const elevationMetrics = computeRouteElevationMetrics(cleanedPoints);
        const surfaceMetrics = computeRouteSurfaceMetricsFromPoints(cleanedPoints);
        const distanceM = elevationMetrics?.distanceM ?? routeLengthM(cleanedPoints);
        const distanceKm = Math.round(distanceM / 100) / 10;

        it.gpxRoute = {
          ...route,
          points: cleanedPoints,
        };
        it.metrics = {
          ...it.metrics,
          distanceKm,
          ascentM: elevationMetrics
            ? Math.max(0, Math.round(elevationMetrics.ascentM))
            : it.metrics?.ascentM,
          descentM: elevationMetrics
            ? Math.max(0, Math.round(elevationMetrics.descentM))
            : it.metrics?.descentM,
          avgSlopePercent: elevationMetrics
            ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
            : it.metrics?.avgSlopePercent,
          tarmacPercent: surfaceMetrics
            ? Math.round(surfaceMetrics.tarmacPercent)
            : it.metrics?.tarmacPercent,
          offroadPercent: surfaceMetrics
            ? Math.round(surfaceMetrics.offroadPercent)
            : it.metrics?.offroadPercent,
        };
        it.timeline = it.timeline.map((row) =>
          row.kind === 'end' ? { ...row, distanceKm } : row,
        );
        it.prediction = null;
      });
    },
    [updateItinerary],
  );

  const mergeItineraries = useCallback(
    (
      sourceId: string,
      targetId: string,
      options?: { connector?: MergeItineraryConnectorSegment },
    ) => {
      const currentProject = projectRef.current;
      const result = mergeItineraryProject(currentProject, sourceId, targetId, options);
      if (!result) return null;

      const entry: TraceHistoryEntry = {
        itineraryId: sourceId,
        before: currentProject,
        after: result.project,
      };
      pushTraceHistoryEntry(entry);

      return {
        mergedItineraryId: result.mergedItineraryId,
        removedItineraryId: result.removedItineraryId,
        mergedItineraryName: result.mergedItineraryName,
        connectorUsed: result.connectorUsed,
      };
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const splitItineraryAtPointIndex = useCallback(
    (id: string, splitIndex: number) => {
      const currentProject = projectRef.current;
      const result = splitItineraryProject(currentProject, id, splitIndex);
      if (!result) return null;

      pushTraceHistoryEntry({
        itineraryId: id,
        before: currentProject,
        after: result.project,
      });
      return {
        createdItineraryId: result.createdItineraryId,
        createdItineraryName: result.createdItineraryName,
      };
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const updateItineraryRoutePoints = useCallback(
    (
      id: string,
      points: Array<{ lat: number; lon: number; elevationM?: number | null; distanceM?: number }>,
      _options?: { source?: string; actionName?: string },
    ) => {
      if (!points || points.length === 0) return false;
      const currentProject = projectRef.current;
      const itinerary = currentProject.itineraries.find((it) => it.id === id);
      if (!itinerary) return false;

      const lengths = cumulativeRouteLengthsM(points);
      const normalizedPoints = points.map((pt, idx) => ({
        lat: pt.lat,
        lon: pt.lon,
        elevationM: Number.isFinite(pt.elevationM) ? pt.elevationM : null,
        distanceM: lengths[idx] ?? 0,
      }));

      const totalDistM = lengths[lengths.length - 1] ?? 0;
      const totalDistKm = roundDistanceKm(totalDistM / 1000);
      const elevMetrics = computeRouteElevationMetrics(normalizedPoints);

      const nextProject: ItineraryProject = {
        ...currentProject,
        itineraries: currentProject.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);

          copy.gpxRoute = {
            name: copy.gpxRoute?.name ?? copy.name ?? translateAppText('Trace modifiée'),
            source: copy.gpxRoute?.source ?? 'gpx',
            points: normalizedPoints,
            originalPoints: copy.gpxRoute?.originalPoints,
          };

          copy.metrics = {
            ...copy.metrics,
            distanceKm: totalDistKm,
            ascentM: elevMetrics?.ascentM ?? copy.metrics?.ascentM ?? 0,
            descentM: elevMetrics?.descentM ?? copy.metrics?.descentM ?? 0,
            avgSlopePercent: elevMetrics?.avgSlopePercent ?? copy.metrics?.avgSlopePercent ?? 0,
          };

          copy.timeline = copy.timeline.map((row) => {
            if (row.kind === 'start') {
              return {
                ...row,
                lat: normalizedPoints[0].lat,
                lon: normalizedPoints[0].lon,
                distanceKm: 0,
              };
            }
            if (row.kind === 'end') {
              return {
                ...row,
                lat: normalizedPoints[normalizedPoints.length - 1].lat,
                lon: normalizedPoints[normalizedPoints.length - 1].lon,
                distanceKm: totalDistKm,
              };
            }
            return row;
          });

          delete copy.pendingTraceExtension;
          delete copy.pendingRoutePatch;
          delete copy.routeAudit;
          copy.prediction = null;

          return copy;
        }),
      };

      const entry: TraceHistoryEntry = {
        itineraryId: id,
        before: currentProject,
        after: nextProject,
      };

      pushTraceHistoryEntry(entry);
      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  return {
    reverseItineraryGpx,
    appendTracePoint,
    addForbiddenZone,
    removeForbiddenZone,
    cleanItineraryGpxGlitches,
    mergeItineraries,
    splitItineraryAtPointIndex,
    updateItineraryRoutePoints,
  };
}
