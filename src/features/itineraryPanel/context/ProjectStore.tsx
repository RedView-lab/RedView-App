import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import {
  createDefaultItinerary,
  createDefaultProject,
  ITINERARY_COLORS,
  normalizeItineraryProject,
} from '../lib/defaultState';
import { cleanGpxGlitches } from '../lib/clean-gpx-glitches';
import {
  mergeItineraryProject,
  type MergeItineraryConnectorSegment,
} from '../lib/merge-itinerary';
import { reverseItineraryGpxProject } from '../lib/reverse-itinerary-gpx';
import { splitItineraryProject, type SplitItineraryProjectResult } from '../lib/split-itinerary';
import { computeRouteElevationMetrics } from '../lib/route-metrics';
import { simplifyRouteToMaxPoints } from '../lib/simplify-route';
import { ProjectStoreContext } from './ProjectStore/context';
import { buildPendingRoutePatchForForbiddenZone } from './ProjectStore/forbiddenZonePatch';
import { useTraceHistory } from './ProjectStore/useTraceHistory';
import type {
  ItineraryForbiddenZone,
  ItineraryProject,
  RouteRenderMode,
} from '../types';
import type {
  ProjectProviderProps,
  ProjectStoreValue,
  TraceHistoryEntry,
} from './ProjectStore/types';
export { useProjectStore, useProjectStoreOptional } from './ProjectStore/hooks';

/**
 * Single source of truth for the active project. Wraps the editor area
 * so that the left itinerary panel, the center summary table, and the
 * right control panel all read from / write to the same state.
 *
 * Remount with a new `key` (typically the project id) to seed a
 * different project — the provider snapshots `initialProject` once.
 */
export function ProjectProvider({
  initialProject,
  onProjectChange,
  children,
}: ProjectProviderProps) {
  const [project, setProjectInternal] = useState<ItineraryProject>(
    () => (initialProject ? normalizeItineraryProject(initialProject) : createDefaultProject()),
  );
  const projectRef = useRef(project);
  projectRef.current = project;

  // Notify the parent of every project mutation so it can persist to
  // Supabase. Using a ref + synchronous notification (inside the
  // updater) so that callers like `pagehide` listeners that mutate
  // state right before the page unloads still propagate the latest
  // snapshot — `useLayoutEffect` would not run in time.
  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;

  const setProject = useCallback<Dispatch<SetStateAction<ItineraryProject>>>(
    (action) => {
      setProjectInternal((prev) => {
        const next =
          typeof action === 'function'
            ? (action as (p: ItineraryProject) => ItineraryProject)(prev)
            : action;
        const normalizedNext = normalizeItineraryProject(next);
        if (normalizedNext === prev) return prev;
        // Synchronously notify the parent so unload flushes capture
        // the freshest snapshot. Every real mutation must be persisted —
        // the previous "skip first change" guard caused the very first
        // user action after opening a project (e.g. a POI corridor
        // search) to be silently dropped if the user refreshed before
        // a second mutation triggered another save.
        try {
          onProjectChangeRef.current?.(normalizedNext);
        } catch (err) {
          console.error('[ProjectProvider] onProjectChange threw', err);
        }
        return normalizedNext;
      });
    },
    [],
  );

  const {
    canUndoTraceEdit,
    canRedoTraceEdit,
    traceHistoryPastCount,
    traceHistoryFutureCount,
    pushTraceHistoryEntry,
    pushTraceHistoryEntries,
    undoTraceEdit,
    redoTraceEdit,
    rollbackPendingTraceAppend,
    setPendingTraceAppend,
  } = useTraceHistory({ setProject });

  const updateItinerary = useCallback(
    (
      id: string,
      mut: (draft: ItineraryProject['itineraries'][number]) => void,
    ) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          mut(copy);
          return copy;
        }),
      }));
    },
    [],
  );

  const setItineraryName = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      updateItinerary(id, (it) => {
        it.name = trimmed;
      });
    },
    [updateItinerary],
  );

  const setItineraryColor = useCallback(
    (id: string, color: string) => {
      updateItinerary(id, (it) => {
        it.color = color;
      });
    },
    [updateItinerary],
  );

  const setItineraryVisibility = useCallback(
    (id: string, visible: boolean) => {
      updateItinerary(id, (it) => {
        it.visible = visible;
      });
    },
    [updateItinerary],
  );

  const setItineraryAnalysisVisibility = useCallback(
    (id: string, visible: boolean) => {
      updateItinerary(id, (it) => {
        it.analysisVisible = visible;
      });
    },
    [updateItinerary],
  );

  const setItineraryRenderMode = useCallback(
    (id: string, mode: RouteRenderMode) => {
      updateItinerary(id, (it) => {
        it.renderMode = mode;
      });
    },
    [updateItinerary],
  );

  const setItineraryOpacity = useCallback(
    (id: string, opacity: number) => {
      updateItinerary(id, (it) => {
        it.opacity = Math.max(0, Math.min(100, Math.round(opacity)));
      });
    },
    [updateItinerary],
  );

  const duplicateItinerary = useCallback(
    (id: string) => {
      let resultBox: { createdItineraryId: string; createdItineraryName: string } | null = null;

      setProject((currentProject) => {
        const source = currentProject.itineraries.find((itinerary) => itinerary.id === id);
        if (!source) return currentProject;

        const nextIndex = currentProject.itineraries.length + 1;
        const color =
          ITINERARY_COLORS[currentProject.itineraries.length % ITINERARY_COLORS.length] ??
          ITINERARY_COLORS[0];
        const duplicateNameBase = `${source.name} (copie)`;
        let duplicateName = duplicateNameBase;
        let suffix = 2;
        while (currentProject.itineraries.some((itinerary) => itinerary.name === duplicateName)) {
          duplicateName = `${duplicateNameBase} ${suffix}`;
          suffix += 1;
        }

        const duplicate = structuredClone(source);
        duplicate.id = `it-${Date.now()}-${nextIndex}`;
        duplicate.name = duplicateName;
        duplicate.color = color;
        duplicate.visible = false;
        duplicate.prediction = null;
        delete duplicate.fitUploads;
        delete duplicate.pendingFitRecompute;
        if (duplicate.metrics) delete duplicate.metrics.durationSec;

        resultBox = {
          createdItineraryId: duplicate.id,
          createdItineraryName: duplicate.name,
        };

        return {
          ...currentProject,
          itineraries: [...currentProject.itineraries, duplicate],
          activeItineraryId: duplicate.id,
        };
      });

      return resultBox;
    },
    [setProject],
  );

  const removeItinerary = useCallback(
    (id: string) => {
      let removed = false;

      setProject((currentProject) => {
        if (currentProject.itineraries.length <= 1) return currentProject;

        const remaining = currentProject.itineraries.filter((itinerary) => itinerary.id !== id);
        if (remaining.length === currentProject.itineraries.length) return currentProject;

        removed = true;
        const nextActive =
          currentProject.activeItineraryId === id
            ? (remaining[0]?.id ?? currentProject.activeItineraryId)
            : currentProject.activeItineraryId;

        return {
          ...currentProject,
          itineraries: remaining,
          activeItineraryId: nextActive,
        };
      });

      return removed;
    },
    [setProject],
  );

  const clearItineraryRoute = useCallback(
    (id: string) => {
      updateItinerary(id, (it) => {
        const emptyTimeline = createDefaultItinerary(1, it.color).timeline;
        it.timeline = structuredClone(emptyTimeline);
        delete it.gpxRoute;
        delete it.metrics;
        delete it.poiFeatures;
        delete it.routeAudit;
        delete it.pendingTraceExtension;
        delete it.pendingRoutePatch;
        it.prediction = null;
      });
    },
    [updateItinerary],
  );

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
    [pushTraceHistoryEntry],
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
      if (
        !startRow ||
        startRow.lat == null ||
        startRow.lon == null ||
        !endRow ||
        endRow.lat == null ||
        endRow.lon == null
      ) {
        return false;
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

          if (copy.metrics) {
            copy.metrics = {
              ...copy.metrics,
              distanceKm: undefined,
              ascentM: undefined,
              descentM: undefined,
              avgSlopePercent: undefined,
              tarmacPercent: undefined,
              offroadPercent: undefined,
            };
          }
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
    [pushTraceHistoryEntry, setPendingTraceAppend],
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
    [pushTraceHistoryEntries],
  );

  const simplifyItineraryGpx = useCallback(
    (id: string, targetPointsPerKm: number) => {
      updateItinerary(id, (it) => {
        const route = it.gpxRoute;
        if (!route || route.source === 'brouter') return;

        const routeDistanceKm = routeLengthM(route.points) / 1000;
        const density = Math.max(1, targetPointsPerKm);
        const nextMaxPoints = Math.max(
          2,
          Math.round(Math.max(routeDistanceKm, 0.25) * density),
        );
        if (route.points.length <= nextMaxPoints) return;

        const simplifiedPoints = simplifyRouteToMaxPoints(route.points, nextMaxPoints);
        if (simplifiedPoints.length >= route.points.length) return;

        const elevationMetrics = computeRouteElevationMetrics(simplifiedPoints);
        const distanceM = elevationMetrics?.distanceM ?? routeLengthM(simplifiedPoints);
        const distanceKm = Math.round(distanceM / 100) / 10;

        it.gpxRoute = {
          ...route,
          points: simplifiedPoints,
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
        };
        it.timeline = it.timeline.map((row) =>
          row.kind === 'end' ? { ...row, distanceKm } : row,
        );
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
              point.elevationM === current.elevationM
            );
          });
        if (geometryUnchanged) return;

        const elevationMetrics = computeRouteElevationMetrics(cleanedPoints);
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
    [pushTraceHistoryEntry],
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

  const value = useMemo<ProjectStoreValue>(
    () => ({
      project,
      setProject,
      undoTraceEdit,
      redoTraceEdit,
      canUndoTraceEdit,
      canRedoTraceEdit,
      rollbackPendingTraceAppend,
      updateItinerary,
      setItineraryName,
      setItineraryColor,
      setItineraryVisibility,
      setItineraryAnalysisVisibility,
      setItineraryRenderMode,
      setItineraryOpacity,
      duplicateItinerary,
      removeItinerary,
      clearItineraryRoute,
      reverseItineraryGpx,
      appendTracePoint,
      addForbiddenZone,
      simplifyItineraryGpx,
      cleanItineraryGpxGlitches,
      mergeItineraries,
      splitItineraryAtPointIndex,
    }),
    [
      project,
      setProject,
      undoTraceEdit,
      redoTraceEdit,
      rollbackPendingTraceAppend,
      traceHistoryPastCount,
      traceHistoryFutureCount,
      updateItinerary,
      setItineraryName,
      setItineraryColor,
      setItineraryVisibility,
      setItineraryAnalysisVisibility,
      setItineraryRenderMode,
      setItineraryOpacity,
      duplicateItinerary,
      removeItinerary,
      clearItineraryRoute,
      reverseItineraryGpx,
      appendTracePoint,
      addForbiddenZone,
      simplifyItineraryGpx,
      cleanItineraryGpxGlitches,
      mergeItineraries,
      splitItineraryAtPointIndex,
    ],
  );

  return (
    <ProjectStoreContext.Provider value={value}>
      {children}
    </ProjectStoreContext.Provider>
  );
}

