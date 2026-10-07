import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import {
  analyzeGpxSurfaces,
  cleanAndInterpolateElevations,
  computeRouteSurfaceMetricsFromPoints,
} from '../../lib/route-metrics';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
  refineImportedRoutePointsWithIgnAltimetry,
  simplifyPointsByQuality,
} from '../../lib/routes';
import { createDefaultAnalysisPanelState, createImportedPoiState } from '../../lib/project';
import type { GpxQualityMode, Itinerary, ItineraryProject } from '../../types';
import { resolveImportedTimelineLabel } from './importedTimelineLabel';
import { reverseGeocodeSettlement } from '../../lib/geocoding';
import { buildImportedGpxWaypoints, GPX_IMPORT_WAYPOINT_ID_PREFIX } from './importedGpxWaypoints';
import { bridgeImportedGpxGaps } from './importedGpxGaps';
import { translateAppText } from '@/shared/i18n';
import { notify } from '@/shared/ui/notify';

/** Taille maximale d'un fichier GPX importé (protection mémoire du parseur). */
export const MAX_GPX_IMPORT_BYTES = 50 * 1024 * 1024;

export class GpxFileTooLargeError extends Error {
  constructor() {
    super(translateAppText('Fichier GPX trop volumineux (50 Mo maximum).'));
    this.name = 'GpxFileTooLargeError';
  }
}

interface UseItineraryGpxImportArgs {
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  addItinerary: (overrides?: Partial<Itinerary>) => string | null;
  setPendingCorridorFor: (id: string | null) => void;
  /**
   * Called with the file name the moment parsing starts, and with `null` once
   * the itinerary has been added (or the import failed). Drives the loading row
   * in the itinerary list, so the user sees the import in the slot the parsed
   * itinerary will occupy.
   */
  onImportStateChange?: (fileName: string | null) => void;
  /**
   * Called after an itinerary has been added from a GPX, with its route points.
   * Used to frame the map on the freshly imported itinerary.
   */
  onItineraryImported?: (itineraryId: string, points: [number, number][]) => void;
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
  onImportStateChange,
  onItineraryImported,
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

      setProject((projectState) => {
        const targetItinerary = projectState.itineraries.find((it) => it.id === itineraryId);
        if (!targetItinerary) return projectState;

        const updatedTimeline = targetItinerary.timeline.map((item) => {
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
        });

        return {
          ...projectState,
          itineraries: projectState.itineraries.map((itinerary) =>
            itinerary.id === itineraryId ? { ...itinerary, timeline: updatedTimeline } : itinerary,
          ),
        };
      });

      // Résolution asynchrone des toponymes des points de passage intermédiaires
      try {
        setProject((projectState) => {
          const target = projectState.itineraries.find((it) => it.id === itineraryId);
          if (!target) return projectState;
          // Les points de passage nommés dans le GPX gardent leur nom.
          const waypointItems = target.timeline.filter(
            (item) =>
              item.kind === 'waypoint'
              && item.lat != null
              && item.lon != null
              && !item.id.startsWith(GPX_IMPORT_WAYPOINT_ID_PREFIX),
          );
          if (waypointItems.length === 0) return projectState;

          void Promise.all(
            waypointItems.map(async (wp) => {
              try {
                const settlement = await reverseGeocodeSettlement(wp.lon!, wp.lat!, {
                  maxDistanceMeters: 1500,
                });
                return { id: wp.id, name: settlement?.name?.trim() || null };
              } catch {
                return { id: wp.id, name: null };
              }
            }),
          ).then((results) => {
            const namedMap = new Map(
              results.filter((r) => r.name).map((r) => [r.id, r.name!]),
            );
            if (namedMap.size === 0) return;

            setProject((latestState) => ({
              ...latestState,
              itineraries: latestState.itineraries.map((itinerary) => {
                if (itinerary.id !== itineraryId) return itinerary;
                return {
                  ...itinerary,
                  timeline: itinerary.timeline.map((item) => {
                    const placeName = namedMap.get(item.id);
                    if (placeName) {
                      return { ...item, label: placeName };
                    }
                    return item;
                  }),
                };
              }),
            }));
          });

          return projectState;
        });
      } catch (err) {
        console.warn('[useItineraryGpxImport] Failed to resolve waypoint settlements:', err);
      }
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
          result.metrics ?? computeRouteSurfaceMetricsFromPoints(enrichedStoredPoints);

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
      if (file.size > MAX_GPX_IMPORT_BYTES) {
        throw new GpxFileTooLargeError();
      }
      // Surface the import in the itinerary list straight away: the list shows
      // a loading row named after the file until the itinerary row replaces it.
      onImportStateChange?.(file.name);
      try {
        // Discontinuités du fichier reliées par la route, jamais en ligne droite.
        const { route, bridged, unbridged } = await bridgeImportedGpxGaps(await parseGpxFile(file));
        if (unbridged > 0) {
          notify.error(
            '{{count}} discontinuité(s) du GPX n’ont pas pu être reliées par le réseau routable : vérifiez le tracé importé.',
            { count: unbridged },
          );
        } else if (bridged > 0) {
          notify.info('{{count}} discontinuité(s) du GPX reliées par le réseau routable.', { count: bridged });
        }
        const ignAltimetryPoints = await refineImportedRoutePointsWithIgnAltimetry(route.points);
        const basePoints = cleanAndInterpolateElevations(ignAltimetryPoints ?? route.points);
        const storedPoints = normalizeImportedRoutePoints(basePoints, { includeGradient: false });
        const quality: GpxQualityMode = 'default';
        const simplifiedPoints = normalizeImportedRoutePoints(
          simplifyPointsByQuality(storedPoints, quality),
        );
        // <wpt> du fichier : POI (favoris préservés) et points de passage nommés.
        const importedWaypoints = buildImportedGpxWaypoints(route, simplifiedPoints);
        const baseTimeline = createImportedTimeline(storedPoints, importedWaypoints.waypointRows);
        const endIndex = baseTimeline.findIndex((item) => item.kind === 'end');
        const timeline = endIndex >= 0
          ? [
            ...baseTimeline.slice(0, endIndex),
            ...importedWaypoints.poiRows,
            ...baseTimeline.slice(endIndex),
          ]
          : [...baseTimeline, ...importedWaypoints.poiRows];
        trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'gpx' } });
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
          metrics: buildImportedRouteMetrics(storedPoints),
          visible: true,
          analysisVisible: true,
          poi: createImportedPoiState(),
          ...(importedWaypoints.poiFeatures.length > 0
            ? { poiFeatures: importedWaypoints.poiFeatures }
            : {}),
        });

        if (id) {
          // Central panel:
          // 1. Only the newly created itinerary is visible in analysis
          // 2. Simple elevation view by default (Altitude / Altitude, distance mode)
          // 3. All analysis filters (poi, pauses, etc.) enabled by default
          setProject((projectState) => ({
            ...projectState,
            itineraries: projectState.itineraries.map((itinerary) => ({
              ...itinerary,
              analysisVisible: itinerary.id === id,
            })),
            activeItineraryId: id,
            analysis: {
              ...createDefaultAnalysisPanelState(),
              xMode: 'distance',
              axis1: 'Altitude',
              axis2: 'Altitude',
              filters: {
                waypoint: true,
                poi: true,
                pause: true,
                pente: true,
                jourNuit: false,
                alertes: true,
                slopeColors: false,
              },
              detailZoom: 0,
              detailOffset: 0,
            },
          }));

          setPendingCorridorFor(id);
          onItineraryImported?.(id, simplifiedPoints.map((point) => [point.lon, point.lat]));
          void hydrateImportedTimelineEndpoints(id, simplifiedPoints);
          void enrichImportedRouteSurfaces(id, storedPoints, quality);
        }
      } finally {
        onImportStateChange?.(null);
      }
    },
    [
      addItinerary,
      enrichImportedRouteSurfaces,
      hydrateImportedTimelineEndpoints,
      onImportStateChange,
      onItineraryImported,
      setPendingCorridorFor,
      setProject,
    ],
  );

  return {
    addItineraryFromGpxFile,
    enrichImportedRouteSurfaces,
    hydrateImportedTimelineEndpoints,
  };
}

