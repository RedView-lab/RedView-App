import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import {
  analyzeGpxSurfaces,
  computeRouteSurfaceMetricsFromPoints,
} from '../../lib/route-metrics';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
  refineImportedRoutePointsWithIgnAltimetry,
  simplifyPointsByQuality,
} from '../../lib/routes';
import type { GpxQualityMode, Itinerary, ItineraryProject } from '../../types';
import { resolveImportedTimelineLabel } from './importedTimelineLabel';

interface UseItineraryGpxImportArgs {
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  addItinerary: (overrides?: Partial<Itinerary>) => string | null;
  setPendingCorridorFor: (id: string | null) => void;
}

/**
 * Gère le chargement, le parsing, le raffinement altimétrique IGN, l'analyse automatique
 * des revêtements de surface (tarmac/gravel/sand/dirt) et l'hydratation
 * d'un itinéraire depuis un fichier GPX externe.
 */
export function useItineraryGpxImport({
  setProject,
  addItinerary,
  setPendingCorridorFor,
}: UseItineraryGpxImportArgs) {
  const hydrateImportedTimelineEndpoints = useCallback(
    async (
      itineraryId: string,
      points: NonNullable<Itinerary['gpxRoute']>['points'],
    ) => {
      const startPoint = points[0];
      const endPoint = points[points.length - 1] ?? startPoint;
      if (!startPoint) return;

      const [startLabel, endLabel] = await Promise.all([
        resolveImportedTimelineLabel(startPoint.lon, startPoint.lat),
        resolveImportedTimelineLabel(endPoint.lon, endPoint.lat),
      ]);

      setProject((projectState) => ({
        ...projectState,
        itineraries: projectState.itineraries.map((itinerary) => {
          if (itinerary.id !== itineraryId) return itinerary;
          return {
            ...itinerary,
            timeline: itinerary.timeline.map((item) => {
              if (item.kind === 'start') {
                return {
                  ...item,
                  label: startLabel,
                  lat: startPoint.lat,
                  lon: startPoint.lon,
                };
              }
              if (item.kind === 'end') {
                return {
                  ...item,
                  label: endLabel,
                  lat: endPoint.lat,
                  lon: endPoint.lon,
                };
              }
              return item;
            }),
          };
        }),
      }));
    },
    [setProject],
  );

  const enrichImportedRouteSurfaces = useCallback(
    async (
      itineraryId: string,
      storedPoints: NonNullable<Itinerary['gpxRoute']>['points'],
      quality: GpxQualityMode = 'default',
      qualityPointsPerKm?: number | null,
    ) => {
      try {
        const result = await analyzeGpxSurfaces(storedPoints);
        const hasSurfaces =
          result.metrics != null ||
          result.points.some((p) => p.surface && p.surface !== 'unknown');

        if (!hasSurfaces) return;

        const enrichedStoredPoints = normalizeImportedRoutePoints(result.points, { includeGradient: false });
        const enrichedSimplifiedPoints = normalizeImportedRoutePoints(
          simplifyPointsByQuality(enrichedStoredPoints, quality, qualityPointsPerKm),
        );
        const surfaceMetrics =
          result.metrics ?? computeRouteSurfaceMetricsFromPoints(enrichedSimplifiedPoints);

        setProject((projectState) => ({
          ...projectState,
          itineraries: projectState.itineraries.map((itinerary) => {
            if (itinerary.id !== itineraryId) return itinerary;
            const currentRoute = itinerary.gpxRoute;
            if (!currentRoute) return itinerary;

            return {
              ...itinerary,
              gpxRoute: {
                ...currentRoute,
                points: enrichedSimplifiedPoints,
                originalPoints: enrichedStoredPoints,
              },
              metrics: {
                ...itinerary.metrics,
                tarmacPercent: surfaceMetrics
                  ? Math.round(surfaceMetrics.tarmacPercent)
                  : itinerary.metrics?.tarmacPercent,
                offroadPercent: surfaceMetrics
                  ? Math.round(surfaceMetrics.offroadPercent)
                  : itinerary.metrics?.offroadPercent,
              },
            };
          }),
        }));
      } catch (error) {
        console.warn('[useItineraryGpxImport] Failed to enrich surfaces for imported GPX:', error);
      }
    },
    [setProject],
  );

  const addItineraryFromGpxFile = useCallback(
    async (file: File) => {
      const route = await parseGpxFile(file);
      const ignAltimetryPoints = await refineImportedRoutePointsWithIgnAltimetry(route.points);
      const basePoints = ignAltimetryPoints ?? route.points;
      const storedPoints = normalizeImportedRoutePoints(basePoints, { includeGradient: false });
      const quality: GpxQualityMode = 'default';
      const simplifiedPoints = normalizeImportedRoutePoints(
        simplifyPointsByQuality(storedPoints, quality),
      );
      const timeline = createImportedTimeline(simplifiedPoints);
      const id = addItinerary({
        name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
        gpxRoute: {
          name: route.name,
          points: simplifiedPoints,
          originalPoints: storedPoints,
          gpxQuality: quality,
          gpxQualityPointsPerKm: null,
          source: 'gpx',
        },
        timeline,
        metrics: buildImportedRouteMetrics(simplifiedPoints),
      });

      if (id) {
        setPendingCorridorFor(id);
        void hydrateImportedTimelineEndpoints(id, simplifiedPoints);
        void enrichImportedRouteSurfaces(id, storedPoints, quality);
      }
    },
    [addItinerary, enrichImportedRouteSurfaces, hydrateImportedTimelineEndpoints, setPendingCorridorFor],
  );

  return {
    addItineraryFromGpxFile,
    enrichImportedRouteSurfaces,
    hydrateImportedTimelineEndpoints,
  };
}

