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
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '../lib/route-distance';

import { createDefaultItinerary, createDefaultProject, ITINERARY_COLORS } from '../defaultState';
import { cleanGpxGlitches } from '../lib/clean-gpx-glitches';
import { splitItineraryProject, type SplitItineraryProjectResult } from '../lib/split-itinerary';
import { computeRouteElevationMetrics } from '../lib/route-metrics';
import { simplifyRouteToMaxPoints } from '../lib/simplify-route';
import type {
  Itinerary,
  ItineraryForbiddenZone,
  ItineraryProject,
  RouteRenderMode,
  TimelineItem,
} from '../types';

interface TraceHistoryEntry {
  itineraryId: string;
  before: ItineraryProject;
  after: ItineraryProject;
}

function isRoutableTimelineRow(
  row: TimelineItem | null | undefined,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row &&
    (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end') &&
    row.lat != null &&
    row.lon != null,
  );
}

function buildPendingRoutePatchForForbiddenZone(
  timeline: TimelineItem[],
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  zone: ItineraryForbiddenZone,
): Itinerary['pendingRoutePatch'] {
  if (routePoints.length < 2 || zone.points.length < 3) return undefined;

  const routeDistances = cumulativeRouteLengthsM(routePoints);
  let minAffectedDistanceM = Number.POSITIVE_INFINITY;
  let maxAffectedDistanceM = Number.NEGATIVE_INFINITY;

  for (let index = 1; index < routePoints.length; index += 1) {
    const start = routePoints[index - 1];
    const end = routePoints[index];
    if (!segmentIntersectsPolygon(start, end, zone.points)) continue;

    minAffectedDistanceM = Math.min(minAffectedDistanceM, routeDistances[index - 1] ?? 0);
    maxAffectedDistanceM = Math.max(maxAffectedDistanceM, routeDistances[index] ?? 0);
  }

  if (!Number.isFinite(minAffectedDistanceM) || !Number.isFinite(maxAffectedDistanceM)) {
    return undefined;
  }

  const routableRows = timeline.filter(isRoutableTimelineRow);
  const rowsWithDistances = routableRows
    .map((row, index) => {
      const distanceM = resolveTimelineRowDistanceM(row, index, routableRows.length, routePoints, routeDistances);
      return distanceM == null ? null : { row, distanceM };
    })
    .filter((entry): entry is { row: typeof routableRows[number]; distanceM: number } => Boolean(entry));
  if (rowsWithDistances.length < 2) return undefined;

  let startIndex = 0;
  for (let index = 0; index < rowsWithDistances.length; index += 1) {
    if (rowsWithDistances[index].distanceM <= minAffectedDistanceM + 1e-6) {
      startIndex = index;
    }
  }

  let endIndex = rowsWithDistances.length - 1;
  for (let index = startIndex + 1; index < rowsWithDistances.length; index += 1) {
    if (rowsWithDistances[index].distanceM >= maxAffectedDistanceM - 1e-6) {
      endIndex = index;
      break;
    }
  }

  if (endIndex <= startIndex) {
    endIndex = Math.min(rowsWithDistances.length - 1, startIndex + 1);
    startIndex = Math.max(0, endIndex - 1);
  }

  const startRow = rowsWithDistances[startIndex]?.row;
  const endRow = rowsWithDistances[endIndex]?.row;
  if (!startRow || !endRow) return undefined;

  return {
    start: { lat: startRow.lat, lon: startRow.lon, kind: startRow.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: endRow.lat, lon: endRow.lon, kind: endRow.kind === 'end' ? 'end' : 'waypoint' },
    via: rowsWithDistances
      .slice(startIndex + 1, endIndex)
      .filter((entry) => entry.row.kind === 'waypoint')
      .map((entry) => ({ lat: entry.row.lat, lon: entry.row.lon })),
  };
}

function resolveTimelineRowDistanceM(
  row: TimelineItem & { lat: number; lon: number },
  index: number,
  rowCount: number,
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  routeDistances: number[],
): number | null {
  if (index === 0 || row.kind === 'start') return 0;
  if (index === rowCount - 1 || row.kind === 'end') {
    return routeDistances[routeDistances.length - 1] ?? 0;
  }
  const projected = projectPointAlongRoute(row, routePoints, routeDistances);
  return projected?.distanceM ?? null;
}

function segmentIntersectsPolygon(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
  polygon: Array<{ lat: number; lon: number }>,
): boolean {
  if (polygon.length < 3) return false;
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true;

  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return true;
  }
  return false;
}

function pointInPolygon(
  point: { lat: number; lon: number },
  polygon: Array<{ lat: number; lon: number }>,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects =
      (a.lat > point.lat) !== (b.lat > point.lat) &&
      point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / ((b.lat - a.lat) || Number.EPSILON) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(
  a1: { lat: number; lon: number },
  a2: { lat: number; lon: number },
  b1: { lat: number; lon: number },
  b2: { lat: number; lon: number },
): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

function orientation(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  c: { lat: number; lon: number },
): number {
  const value = ((b.lat - a.lat) * (c.lon - b.lon)) - ((b.lon - a.lon) * (c.lat - b.lat));
  if (Math.abs(value) <= 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  c: { lat: number; lon: number },
): boolean {
  return (
    b.lon <= Math.max(a.lon, c.lon) + 1e-12 &&
    b.lon >= Math.min(a.lon, c.lon) - 1e-12 &&
    b.lat <= Math.max(a.lat, c.lat) + 1e-12 &&
    b.lat >= Math.min(a.lat, c.lat) - 1e-12
  );
}

interface ProjectStoreValue {
  project: ItineraryProject;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  undoTraceEdit: () => void;
  redoTraceEdit: () => void;
  canUndoTraceEdit: boolean;
  canRedoTraceEdit: boolean;
  rollbackPendingTraceAppend: (itineraryId: string) => boolean;
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
  addForbiddenZone: (
    id: string,
    points: Array<{ lat: number; lon: number }>,
  ) => ItineraryForbiddenZone | null;
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
  const projectRef = useRef(project);
  projectRef.current = project;

  // Notify the parent of every project mutation so it can persist to
  // Supabase. Using a ref + synchronous notification (inside the
  // updater) so that callers like `pagehide` listeners that mutate
  // state right before the page unloads still propagate the latest
  // snapshot — `useLayoutEffect` would not run in time.
  const onProjectChangeRef = useRef(onProjectChange);
  onProjectChangeRef.current = onProjectChange;
  const [traceHistoryPast, setTraceHistoryPast] = useState<TraceHistoryEntry[]>([]);
  const [traceHistoryFuture, setTraceHistoryFuture] = useState<TraceHistoryEntry[]>([]);
  const traceHistoryPastRef = useRef<TraceHistoryEntry[]>([]);
  const traceHistoryFutureRef = useRef<TraceHistoryEntry[]>([]);
  const pendingTraceAppendRef = useRef<TraceHistoryEntry | null>(null);

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

  const syncTraceHistory = useCallback((past: TraceHistoryEntry[], future: TraceHistoryEntry[]) => {
    traceHistoryPastRef.current = past;
    traceHistoryFutureRef.current = future;
    setTraceHistoryPast(past);
    setTraceHistoryFuture(future);
  }, []);

  const pushTraceHistoryEntry = useCallback(
    (
      entry: TraceHistoryEntry,
      options?: { preservePendingTraceAppend?: boolean },
    ) => {
      if (!options?.preservePendingTraceAppend) {
        pendingTraceAppendRef.current = null;
      }
      syncTraceHistory([...traceHistoryPastRef.current, entry], []);
      setProject(entry.after);
    },
    [setProject, syncTraceHistory],
  );

  const undoTraceEdit = useCallback(() => {
    const past = traceHistoryPastRef.current;
    const entry = past[past.length - 1];
    if (!entry) return;

    pendingTraceAppendRef.current = null;
    syncTraceHistory(past.slice(0, -1), [entry, ...traceHistoryFutureRef.current]);
    setProject(entry.before);
  }, [setProject, syncTraceHistory]);

  const redoTraceEdit = useCallback(() => {
    const future = traceHistoryFutureRef.current;
    const [entry, ...rest] = future;
    if (!entry) return;

    pendingTraceAppendRef.current = null;
    syncTraceHistory([...traceHistoryPastRef.current, entry], rest);
    setProject(entry.after);
  }, [setProject, syncTraceHistory]);

  const rollbackPendingTraceAppend = useCallback(
    (itineraryId: string) => {
      const pending = pendingTraceAppendRef.current;
      if (!pending || pending.itineraryId !== itineraryId) return false;

      pendingTraceAppendRef.current = null;
      const past = traceHistoryPastRef.current;
      const last = past[past.length - 1];
      const nextPast = last === pending ? past.slice(0, -1) : past;
      syncTraceHistory(nextPast, []);
      setProject(pending.before);
      return true;
    },
    [setProject, syncTraceHistory],
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
        delete it.pendingTraceExtension;
        delete it.pendingRoutePatch;
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
      pendingTraceAppendRef.current = entry;
      pushTraceHistoryEntry(entry, { preservePendingTraceAppend: true });
      return true;
    },
    [pushTraceHistoryEntry],
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

      const nextProject: ItineraryProject = {
        ...currentProject,
        itineraries: currentProject.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          copy.forbiddenZones = [...(copy.forbiddenZones ?? []), zone];
          if (copy.gpxRoute?.source === 'brouter' && (copy.gpxRoute.points.length ?? 0) >= 2) {
            copy.pendingRoutePatch = buildPendingRoutePatchForForbiddenZone(
              copy.timeline,
              copy.gpxRoute.points,
              zone,
            );
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
      pushTraceHistoryEntry(entry);
      return zone;
    },
    [pushTraceHistoryEntry],
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
      undoTraceEdit,
      redoTraceEdit,
      canUndoTraceEdit: traceHistoryPast.length > 0,
      canRedoTraceEdit: traceHistoryFuture.length > 0,
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
      appendTracePoint,
      addForbiddenZone,
      simplifyItineraryGpx,
      cleanItineraryGpxGlitches,
      splitItineraryAtPointIndex,
    }),
    [
      project,
      setProject,
      undoTraceEdit,
      redoTraceEdit,
      rollbackPendingTraceAppend,
      traceHistoryPast.length,
      traceHistoryFuture.length,
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
      addForbiddenZone,
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
