import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import { createDefaultItinerary, createDefaultProject, ITINERARY_COLORS } from '../defaultState';
import { cleanGpxGlitches } from '../lib/clean-gpx-glitches';
import { splitItineraryProject, type SplitItineraryProjectResult } from '../lib/split-itinerary';
import { computeRouteElevationMetrics } from '../lib/route-metrics';
import { simplifyRouteToMaxPoints } from '../lib/simplify-route';
import type { ItineraryProject, RouteRenderMode } from '../types';

interface ProjectStoreValue {
  project: ItineraryProject;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  /** Mutate a single itinerary by id (Immer-style draft mutation). */
  updateItinerary: (
    id: string,
    mut: (draft: ItineraryProject['itineraries'][number]) => void,
  ) => void;
  setItineraryName: (id: string, name: string) => void;
  setItineraryColor: (id: string, color: string) => void;
  setItineraryVisibility: (id: string, visible: boolean) => void;
  setItineraryAnalysisVisibility: (id: string, visible: boolean) => void;
  setItineraryRenderMode: (id: string, mode: RouteRenderMode) => void;
  setItineraryOpacity: (id: string, opacity: number) => void;
  duplicateItinerary: (id: string) => { createdItineraryId: string; createdItineraryName: string } | null;
  removeItinerary: (id: string) => boolean;
  clearItineraryRoute: (id: string) => void;
  appendTracePoint: (
    id: string,
    point: { lat: number; lon: number; label: string },
  ) => boolean;
  simplifyItineraryGpx: (id: string, targetPointsPerKm: number) => void;
  cleanItineraryGpxGlitches: (id: string) => void;
  splitItineraryAtPointIndex: (
    id: string,
    splitIndex: number,
  ) => Omit<SplitItineraryProjectResult, 'project'> | null;
}

const ProjectStoreContext = createContext<ProjectStoreValue | null>(null);

interface ProjectProviderProps {
  initialProject?: ItineraryProject;
  /**
   * Notified after every project mutation. Used by the Dashboard to
   * persist changes to Supabase (debounced).
   */
  onProjectChange?: (project: ItineraryProject) => void;
  children: ReactNode;
}

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
    () => initialProject ?? createDefaultProject(),
  );

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
        if (next === prev) return prev;
        // Synchronously notify the parent so unload flushes capture
        // the freshest snapshot. Every real mutation must be persisted —
        // the previous "skip first change" guard caused the very first
        // user action after opening a project (e.g. a POI corridor
        // search) to be silently dropped if the user refreshed before
        // a second mutation triggered another save.
        try {
          onProjectChangeRef.current?.(next);
        } catch (err) {
          console.error('[ProjectProvider] onProjectChange threw', err);
        }
        return next;
      });
    },
    [],
  );

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
        it.prediction = null;
      });
    },
    [updateItinerary],
  );

  const appendTracePoint = useCallback(
    (
      id: string,
      point: { lat: number; lon: number; label: string },
    ) => {
      let appended = false;

      updateItinerary(id, (it) => {
        const startRow = it.timeline.find((row) => row.kind === 'start');
        const endIndex = it.timeline.findIndex((row) => row.kind === 'end');
        const endRow = endIndex >= 0 ? it.timeline[endIndex] : null;
        if (
          !startRow ||
          startRow.lat == null ||
          startRow.lon == null ||
          !endRow ||
          endRow.lat == null ||
          endRow.lon == null
        ) {
          return;
        }

        const waypointId = `wp-${Date.now()}-${Math.round(point.lat * 1e5)}-${Math.round(point.lon * 1e5)}`;
        const previousEndWaypoint = {
          ...endRow,
          id: waypointId,
          kind: 'waypoint' as const,
          distanceKm: null,
        };
        const nextEndRow = {
          ...endRow,
          label: point.label,
          lat: point.lat,
          lon: point.lon,
          distanceKm: null,
        };

        it.timeline.splice(endIndex, 1, previousEndWaypoint, nextEndRow);
        it.timeline = it.timeline.map((row) => {
          if (row.kind === 'start') {
            return row.distanceKm === 0 ? row : { ...row, distanceKm: 0 };
          }
          if (row.kind === 'waypoint' || row.kind === 'end') {
            return row.distanceKm == null ? row : { ...row, distanceKm: null };
          }
          return row;
        });

        if (it.metrics) {
          it.metrics = {
            ...it.metrics,
            distanceKm: undefined,
            ascentM: undefined,
            descentM: undefined,
            avgSlopePercent: undefined,
            tarmacPercent: undefined,
            offroadPercent: undefined,
          };
        }
        delete it.routeAudit;
        it.prediction = null;
        appended = true;
      });

      return appended;
    },
    [updateItinerary],
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
      appendTracePoint,
      simplifyItineraryGpx,
      cleanItineraryGpxGlitches,
      splitItineraryAtPointIndex,
    }),
    [
      project,
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
      appendTracePoint,
      simplifyItineraryGpx,
      cleanItineraryGpxGlitches,
      splitItineraryAtPointIndex,
    ],
  );

  return (
    <ProjectStoreContext.Provider value={value}>
      {children}
    </ProjectStoreContext.Provider>
  );
}

/**
 * Read the active project + mutators from the surrounding
 * `<ProjectProvider>`. Throws when used outside the provider so
 * misuse is caught early in development.
 */
export function useProjectStore(): ProjectStoreValue {
  const ctx = useContext(ProjectStoreContext);
  if (!ctx) {
    throw new Error('useProjectStore must be used within <ProjectProvider>');
  }
  return ctx;
}

/**
 * Optional variant — returns null instead of throwing when no provider
 * is mounted. Useful for components rendered outside the editor (e.g.
 * the project browser overlay) that should silently no-op.
 */
export function useProjectStoreOptional(): ProjectStoreValue | null {
  return useContext(ProjectStoreContext);
}
