import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import { GpxParseError } from '@/features/poi/lib/gpx-parse';
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
import { notify } from '@/shared/lib/notify';

/** Taille maximale d'un fichier GPX importé (protection mémoire du parseur). */
const MAX_GPX_IMPORT_BYTES = 50 * 1024 * 1024;

export class GpxFileTooLargeError extends Error {
  constructor() {
    super('Fichier GPX trop volumineux (50 Mo maximum).');
    this.name = 'GpxFileTooLargeError';
  }
}

/**
 * Message à montrer quand un import GPX échoue (texte source, traduit par
 * `notify`) : la raison quand le fichier est refusé, sinon un message général.
 */
export function describeGpxImportError(error: unknown): string {
  if (error instanceof GpxFileTooLargeError || error instanceof GpxParseError) return error.message;
  return 'Impossible d’importer ce GPX. Vérifiez le fichier puis réessayez.';
}

interface UseItineraryGpxImportArgs {
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  addItinerary: (overrides?: Partial<Itinerary>) => string | null;
  setPendingCorridorFor: (id: string | null) => void;
  /**
   * Appelé avec le nom du fichier au début du parse, puis avec `null` une fois
   * l'itinéraire ajouté (ou l'import échoué). Pilote la ligne de chargement de la
   * liste des itinéraires, pour que l'utilisateur voie l'import à l'emplacement
   * qu'occupera l'itinéraire parsé.
   */
  onImportStateChange?: (fileName: string | null) => void;
  /**
   * Appelé après l'ajout d'un itinéraire depuis un GPX, avec ses points de tracé.
   * Sert à cadrer la carte sur l'itinéraire tout juste importé.
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
      // Montrer l'import dans la liste des itinéraires tout de suite : la liste
      // affiche une ligne de chargement au nom du fichier jusqu'à ce que la ligne de l'itinéraire la remplace.
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
          // Panneau central :
          // 1. Seul l'itinéraire nouvellement créé est visible dans l'analyse
          // 2. Vue d'altitude simple par défaut (Altitude / Altitude, mode distance)
          // 3. Tous les filtres d'analyse (POI, pauses, etc.) activés par défaut
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

