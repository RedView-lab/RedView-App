import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { routeLengthM } from '@/features/poi/lib/gpx-loader';
import {
  applyGpxQuality,
  cleanGpxGlitches,
  normalizeImportedRoutePoints,
  cumulativeRouteLengthsM,
  projectDistanceAlongRouteM,
  roundDistanceKm,
} from '../../lib/routes';
import {
  mergeItineraryProject,
  type MergeItineraryConnectorSegment,
} from '../../lib/project';
import { reverseItineraryGpxProject } from '../../lib/project';
import { splitItineraryProject, type SplitItineraryProjectResult } from '../../lib/project';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromPoints,
} from '../../lib/route-metrics';
import {
  buildPendingRoutePatchForForbiddenZone,
  pointInPolygon,
} from './forbiddenZonePatch';
import type {
  GpxQualityMode,
  ItineraryForbiddenZone,
  ItineraryProject,
} from '../../types';
import type { TraceHistoryEntry } from './types';

interface UseItineraryGpxActionsArgs {
  projectRef: MutableRefObject<ItineraryProject>;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  updateItinerary: (id: string, mut: (draft: ItineraryProject['itineraries'][number]) => void) => void;
  pushTraceHistoryEntry: (entry: TraceHistoryEntry, options?: { preservePendingTraceAppend?: boolean }) => void;
  pushTraceHistoryEntries: (entries: TraceHistoryEntry[]) => void;
  setPendingTraceAppend: (entry: TraceHistoryEntry | null) => void;
}

/**
 * Gère les transformations avancées de traces GPX et les zones interdites
 * (inversion, ajout de points, simplification, zones interdites, fusion, scission).
 */
export function useItineraryGpxActions({
  projectRef,
  setProject,
  updateItinerary,
  pushTraceHistoryEntry,
  pushTraceHistoryEntries,
  setPendingTraceAppend,
}: UseItineraryGpxActionsArgs) {
  const reverseItineraryGpx = useCallback(
    (id: string) => {
      const currentProject = projectRef.current;
      const nextProject = reverseItineraryGpxProject(currentProject, id);
      if (!nextProject) return false;

      const entry: TraceHistoryEntry = {
        itineraryId: id,
        before: structuredClone(currentProject),
        after: structuredClone(nextProject),
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

      const startRow = itinerary.timeline.find((row) => row.kind === 'start');
      const endIndex = itinerary.timeline.findIndex((row) => row.kind === 'end');
      const endRow = endIndex >= 0 ? itinerary.timeline[endIndex] : null;
      if (!startRow || !endRow || endIndex < 0) {
        return false;
      }

      const resetMetrics = (metrics: typeof itinerary.metrics) => {
        if (!metrics) return metrics;
        return {
          ...metrics,
          distanceKm: undefined,
          ascentM: undefined,
          descentM: undefined,
          avgSlopePercent: undefined,
          tarmacPercent: undefined,
          offroadPercent: undefined,
        };
      };

      if (startRow.lat == null || startRow.lon == null) {
        const nextProject = {
          ...currentProject,
          itineraries: currentProject.itineraries.map((it) => {
            if (it.id !== id) return it;
            const copy = structuredClone(it);
            const currentStart = copy.timeline.find((row) => row.kind === 'start');
            if (!currentStart) return copy;

            currentStart.label = point.label;
            currentStart.lat = point.lat;
            currentStart.lon = point.lon;
            currentStart.distanceKm = 0;
            copy.metrics = resetMetrics(copy.metrics);
            delete copy.routeAudit;
            delete copy.pendingTraceExtension;
            delete copy.pendingRoutePatch;
            copy.prediction = null;
            return copy;
          }),
        };

        const entry: TraceHistoryEntry = {
          itineraryId: id,
          before: structuredClone(currentProject),
          after: structuredClone(nextProject),
        };
        setPendingTraceAppend(null);
        pushTraceHistoryEntry(entry);
        return true;
      }

      if (endRow.lat == null || endRow.lon == null) {
        const nextProject = {
          ...currentProject,
          itineraries: currentProject.itineraries.map((it) => {
            if (it.id !== id) return it;
            const copy = structuredClone(it);
            const currentEnd = copy.timeline.find((row) => row.kind === 'end');
            if (!currentEnd) return copy;

            currentEnd.label = point.label;
            currentEnd.lat = point.lat;
            currentEnd.lon = point.lon;
            currentEnd.distanceKm = null;
            copy.metrics = resetMetrics(copy.metrics);
            delete copy.routeAudit;
            delete copy.pendingTraceExtension;
            delete copy.pendingRoutePatch;
            copy.prediction = null;
            return copy;
          }),
        };

        const entry: TraceHistoryEntry = {
          itineraryId: id,
          before: structuredClone(currentProject),
          after: structuredClone(nextProject),
        };
        setPendingTraceAppend(null);
        pushTraceHistoryEntry(entry);
        return true;
      }

      const previousEndLat = endRow.lat;
      const previousEndLon = endRow.lon;
      const waypointId = `wp-${Date.now()}-${Math.round(point.lat * 1e5)}-${Math.round(point.lon * 1e5)}`;

      const nextProject = {
        ...currentProject,
        itineraries: currentProject.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          const previousEndWaypoint = {
            ...endRow,
            id: waypointId,
            kind: 'waypoint' as const,
            distanceKm: endRow.distanceKm,
          };
          const nextEndRow = {
            ...endRow,
            label: point.label,
            lat: point.lat,
            lon: point.lon,
            distanceKm: null,
          };

          copy.timeline.splice(endIndex, 1, previousEndWaypoint, nextEndRow);
          copy.timeline = copy.timeline.map((row) => {
            if (row.kind === 'start') {
              return row.distanceKm === 0 ? row : { ...row, distanceKm: 0 };
            }
            if (row.kind === 'end') {
              return row.distanceKm == null ? row : { ...row, distanceKm: null };
            }
            return row;
          });

          if (copy.gpxRoute?.source === 'brouter' && (copy.gpxRoute.points.length ?? 0) >= 2) {
            copy.pendingTraceExtension = {
              from: { lat: previousEndLat, lon: previousEndLon },
              to: { lat: point.lat, lon: point.lon },
            };
            delete copy.pendingRoutePatch;
          } else {
            delete copy.pendingTraceExtension;
            delete copy.pendingRoutePatch;
          }

          copy.metrics = resetMetrics(copy.metrics);
          delete copy.routeAudit;
          copy.prediction = null;
          return copy;
        }),
      };

      const entry: TraceHistoryEntry = {
        itineraryId: id,
        before: structuredClone(currentProject),
        after: structuredClone(nextProject),
      };
      setPendingTraceAppend(entry);
      pushTraceHistoryEntry(entry, { preservePendingTraceAppend: true });
      return true;
    },
    [projectRef, pushTraceHistoryEntry, setPendingTraceAppend],
  );

  const addForbiddenZone = useCallback(
    (id: string, points: Array<{ lat: number; lon: number }>) => {
      if (points.length < 3) return null;

      const currentProject = projectRef.current;
      const itinerary = currentProject.itineraries.find((it) => it.id === id);
      if (!itinerary) return null;

      const zone: ItineraryForbiddenZone = {
        id: `fz-${Date.now()}-${Math.round(points[0].lat * 1e5)}-${Math.round(points[0].lon * 1e5)}`,
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
            if (copy.gpxRoute?.source === 'brouter' && (copy.gpxRoute.points.length ?? 0) >= 2) {
              copy.pendingRoutePatch = buildPendingRoutePatchForForbiddenZone(
                copy.timeline,
                copy.gpxRoute.points,
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
          before: structuredClone(workingProject),
          after: structuredClone(nextProject),
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
        before: structuredClone(currentProject),
        after: structuredClone(nextProject),
      };
      pushTraceHistoryEntry(entry);
      return true;
    },
    [projectRef, pushTraceHistoryEntry],
  );

  const simplifyItineraryGpx = useCallback(
    (id: string, targetPointsPerKm: number) => {
      updateItinerary(id, (it) => {
        const route = it.gpxRoute;
        if (!route || route.source === 'brouter') return;

        const basePoints = route.originalPoints || route.points;
        const qualityResult = applyGpxQuality(basePoints, 'expert', targetPointsPerKm);
        if (qualityResult.points.length >= route.points.length && route.gpxQuality === 'expert') return;

        const simplifiedPoints = normalizeImportedRoutePoints(qualityResult.points);
        const elevationMetrics = computeRouteElevationMetrics(simplifiedPoints);
        const surfaceMetrics = computeRouteSurfaceMetricsFromPoints(simplifiedPoints);
        const distanceM = elevationMetrics?.distanceM ?? routeLengthM(simplifiedPoints);
        const distanceKm = Math.round(distanceM / 100) / 10;

        it.gpxRoute = {
          ...route,
          points: simplifiedPoints,
          originalPoints: basePoints,
          gpxQuality: 'expert',
          gpxQualityPointsPerKm: qualityResult.pointsPerKm,
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

  const changeItineraryGpxQuality = useCallback(
    (
      id: string,
      quality: GpxQualityMode,
      options?: { pointsPerKm?: number | null },
    ) => {
      updateItinerary(id, (it) => {
        const route = it.gpxRoute;
        if (!route || route.source === 'brouter') return;

        const basePoints = route.originalPoints || route.points;
        const qualityResult = applyGpxQuality(basePoints, quality, options?.pointsPerKm);
        const simplifiedPoints = normalizeImportedRoutePoints(qualityResult.points);

        const elevationMetrics = computeRouteElevationMetrics(simplifiedPoints);
        const surfaceMetrics = computeRouteSurfaceMetricsFromPoints(simplifiedPoints);
        const distanceM = elevationMetrics?.distanceM ?? routeLengthM(simplifiedPoints);
        const distanceKm = Math.round(distanceM / 100) / 10;

        it.gpxRoute = {
          ...route,
          points: simplifiedPoints,
          originalPoints: basePoints,
          gpxQuality: quality,
          gpxQualityPointsPerKm: quality === 'expert' ? qualityResult.pointsPerKm : null,
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
        const cumulativeLengthsM = cumulativeRouteLengthsM(simplifiedPoints);
        it.timeline = it.timeline.map((row) => {
          if (row.kind === 'start') {
            return { ...row, distanceKm: 0 };
          }
          if (row.kind === 'end') {
            return { ...row, distanceKm };
          }
          if (row.lat != null && row.lon != null) {
            const projectedDistM = projectDistanceAlongRouteM(
              { lat: row.lat, lon: row.lon },
              simplifiedPoints,
              cumulativeLengthsM,
            );
            if (projectedDistM != null) {
              return { ...row, distanceKm: roundDistanceKm(projectedDistM) };
            }
          }
          return row;
        });
        it.prediction = null;
      });
    },
    [updateItinerary],
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
        before: structuredClone(currentProject),
        after: structuredClone(result.project),
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
      let resultBox: Omit<SplitItineraryProjectResult, 'project'> | null = null;
      setProject((prev) => {
        const result = splitItineraryProject(prev, id, splitIndex);
        resultBox = result
          ? {
              createdItineraryId: result.createdItineraryId,
              createdItineraryName: result.createdItineraryName,
            }
          : null;
        return result?.project ?? prev;
      });
      return resultBox;
    },
    [setProject],
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
            name: copy.gpxRoute?.name ?? copy.name ?? 'Trace modifiée',
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
        before: structuredClone(currentProject),
        after: structuredClone(nextProject),
      };

      setProject(nextProject);
      pushTraceHistoryEntry(entry);
      return true;
    },
    [projectRef, setProject, pushTraceHistoryEntry],
  );

  return {
    reverseItineraryGpx,
    appendTracePoint,
    addForbiddenZone,
    removeForbiddenZone,
    simplifyItineraryGpx,
    changeItineraryGpxQuality,
    cleanItineraryGpxGlitches,
    mergeItineraries,
    splitItineraryAtPointIndex,
    updateItineraryRoutePoints,
  };
}
