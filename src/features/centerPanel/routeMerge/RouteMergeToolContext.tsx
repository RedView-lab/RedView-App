import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  mergeItineraryProject,
  MERGE_CONNECT_THRESHOLD_M,
  shouldRouteMergedGap,
  type MergeItineraryConnectorSegment,
  type MergeItineraryProjectResult,
} from '@/features/itineraryPanel/lib/merge-itinerary';
import {
  checkRouteWithinFrance,
  fetchBrouterRoute,
  fetchBrouterRouteBestOfN,
  formatForbiddenZonePolygons,
  isClimbingMode,
  resolveItineraryRouting,
} from '@/features/itineraryPanel/lib/brouter';
import {
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
} from '@/features/itineraryPanel/lib/route-metrics';

interface RouteMergeToolContextValue {
  armed: boolean;
  canMerge: boolean;
  isMerging: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
  selectItinerary: (id: string) => void;
  canSelectItinerary: (id: string) => boolean;
  getSelectionOrder: (id: string) => number | null;
}

const RouteMergeToolContext = createContext<RouteMergeToolContextValue | null>(null);

interface RouteMergeToolProviderProps {
  children: ReactNode;
}

function toConnectorSegment(route: Awaited<ReturnType<typeof fetchBrouterRoute>>): MergeItineraryConnectorSegment {
  const profile = extractRouteProfileFromBrouter(route);
  const surfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  return {
    points: profile
      ? profile.map((point) => ({
          lat: point.lat,
          lon: point.lon,
          distanceM: point.distanceM,
          elevationM: point.elevationM,
          gradientPct: point.gradientPct,
        }))
      : route.coordinates.map(([lon, lat], index) => ({
          lat,
          lon,
          distanceM: index === 0 ? 0 : undefined,
        })),
    distanceM: route.distanceM,
    tarmacPercent: surfaceMetrics ? Math.round(surfaceMetrics.tarmacPercent) : undefined,
    offroadPercent: surfaceMetrics ? Math.round(surfaceMetrics.offroadPercent) : undefined,
  };
}

export function RouteMergeToolProvider({ children }: RouteMergeToolProviderProps) {
  const store = useProjectStoreOptional();
  const [armed, setArmed] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const mergeableIds = useMemo(
    () =>
      new Set(
        (store?.project.itineraries ?? [])
          .filter((itinerary) => (itinerary.gpxRoute?.points.length ?? 0) >= 2)
          .map((itinerary) => itinerary.id),
      ),
    [store?.project.itineraries],
  );
  const canMerge = mergeableIds.size >= 2;

  const deactivate = useCallback(() => {
    setArmed(false);
    setSelectedIds([]);
    setIsMerging(false);
    setStatusMessage(null);
  }, []);

  const canSelectItinerary = useCallback(
    (id: string) => !isMerging && mergeableIds.has(id),
    [isMerging, mergeableIds],
  );

  const getSelectionOrder = useCallback(
    (id: string) => {
      const index = selectedIds.indexOf(id);
      return index >= 0 ? index + 1 : null;
    },
    [selectedIds],
  );

  const mergeSelectedItineraries = useCallback(
    async (sourceId: string, targetId: string) => {
      if (!store) return false;

      const source = store.project.itineraries.find((itinerary) => itinerary.id === sourceId);
      const target = store.project.itineraries.find((itinerary) => itinerary.id === targetId);
      if (!source || !target) {
        setStatusMessage('Fusion impossible: trace introuvable.');
        return false;
      }
      if ((source.gpxRoute?.points.length ?? 0) < 2 || (target.gpxRoute?.points.length ?? 0) < 2) {
        setStatusMessage('Fusion impossible: il faut deux traces calculées.');
        return false;
      }
      const sourceRoute = source.gpxRoute;
      const targetRoute = target.gpxRoute;
      if (!sourceRoute || !targetRoute) {
        setStatusMessage('Fusion impossible: trace source ou cible invalide.');
        return false;
      }

      setSelectedIds([sourceId, targetId]);
      setIsMerging(true);
      setStatusMessage('Fusion en cours...');

      try {
        let connector: MergeItineraryConnectorSegment | undefined;
        if (shouldRouteMergedGap(source, target, MERGE_CONNECT_THRESHOLD_M)) {
          const sourceEnd = sourceRoute.points[sourceRoute.points.length - 1];
          const targetStart = targetRoute.points[0];
          if (!sourceEnd || !targetStart) {
            throw new Error('Fusion impossible: extrémités de trace invalides.');
          }

          const bounds = checkRouteWithinFrance([sourceEnd, targetStart]);
          if (!bounds.ok) {
            throw new Error(bounds.reason ?? 'Le raccord de fusion sort de la zone autorisée.');
          }

          const resolved = await resolveItineraryRouting(source);
          const polygons = formatForbiddenZonePolygons([
            ...(source.forbiddenZones ?? []),
            ...(target.forbiddenZones ?? []),
          ]);
          const request = {
            start: { lat: sourceEnd.lat, lon: sourceEnd.lon },
            end: { lat: targetStart.lat, lon: targetStart.lon },
            via: [] as Array<{ lat: number; lon: number }>,
            polygons,
            profile: resolved.profileId,
          };
          const route = isClimbingMode(source.priorities)
            ? await fetchBrouterRouteBestOfN(request, 4)
            : await fetchBrouterRoute(request);
          connector = toConnectorSegment(route);
        }

        let resultBox: Omit<MergeItineraryProjectResult, 'project'> | null = null;
        let usedConnector = false;
        store.setProject((currentProject) => {
          const result = mergeItineraryProject(currentProject, sourceId, targetId, { connector });
          usedConnector = result?.connectorUsed === true;
          resultBox = result
            ? {
                mergedItineraryId: result.mergedItineraryId,
                removedItineraryId: result.removedItineraryId,
                mergedItineraryName: result.mergedItineraryName,
                connectorUsed: result.connectorUsed,
              }
            : null;
          return result?.project ?? currentProject;
        });

        if (!resultBox) {
          throw new Error('Fusion impossible avec les traces sélectionnées.');
        }

        setArmed(false);
        setSelectedIds([]);
        setStatusMessage(
          usedConnector
            ? 'Fusion créée avec raccord BRouter entre les deux traces.'
            : 'Fusion créée.',
        );
        return true;
      } catch (error) {
        console.error('[Route merge fail]', error);
        setSelectedIds([sourceId]);
        setStatusMessage(error instanceof Error ? error.message : 'Erreur pendant la fusion.');
        return false;
      } finally {
        setIsMerging(false);
      }
    },
    [store],
  );

  const selectItinerary = useCallback(
    (id: string) => {
      if (!armed || isMerging || !canSelectItinerary(id) || !store) return;

      if (selectedIds.length === 0) {
        setSelectedIds([id]);
        setStatusMessage('Trace source sélectionnée. Choisissez la trace à ajouter.');
        store.setProject((project) =>
          project.activeItineraryId === id ? project : { ...project, activeItineraryId: id },
        );
        return;
      }

      if (selectedIds.length === 1 && selectedIds[0] === id) {
        setSelectedIds([]);
        setStatusMessage('Sélectionnez le tracé source puis le tracé à fusionner.');
        return;
      }

      if (selectedIds.includes(id)) return;

      void mergeSelectedItineraries(selectedIds[0], id);
    },
    [armed, canSelectItinerary, isMerging, mergeSelectedItineraries, selectedIds, store],
  );

  const toggle = useCallback(() => {
    if (!canMerge || isMerging) return;
    setArmed((current) => {
      const next = !current;
      setSelectedIds([]);
      setStatusMessage(next ? 'Sélectionnez le tracé source puis le tracé à fusionner.' : null);
      return next;
    });
  }, [canMerge, isMerging]);

  useEffect(() => {
    if (canMerge) return;
    setArmed(false);
    setSelectedIds([]);
    setIsMerging(false);
  }, [canMerge]);

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => mergeableIds.has(id)));
  }, [mergeableIds]);

  const value = useMemo<RouteMergeToolContextValue>(
    () => ({
      armed,
      canMerge,
      isMerging,
      statusMessage,
      toggle,
      deactivate,
      selectItinerary,
      canSelectItinerary,
      getSelectionOrder,
    }),
    [armed, canMerge, canSelectItinerary, deactivate, getSelectionOrder, isMerging, selectItinerary, statusMessage, toggle],
  );

  return (
    <RouteMergeToolContext.Provider value={value}>
      {children}
    </RouteMergeToolContext.Provider>
  );
}

export function useRouteMergeToolOptional(): RouteMergeToolContextValue | null {
  return useContext(RouteMergeToolContext);
}