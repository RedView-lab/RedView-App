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
  buildRouteGeometrySignature,
  createImportedTimeline,
  normalizeImportedRoutePoints,
  simplifyPointsByQuality,
} from '../../lib/routes';
import { refineImportedRoutePointsWithIgnAltimetry } from '../../lib/routes/imported-route-altimetry';
import { createDefaultAnalysisPanelState, createImportedPoiState } from '../../lib/project';
import type { GpxQualityMode, Itinerary, ItineraryProject, TimelineItem } from '../../types';
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
  /**
   * Remplace les libellés de l'import (coordonnées GPS) par les noms de lieux
   * résolus en arrière-plan, seulement sur les lignes que l'utilisateur n'a ni
   * déplacées ni renommées entre-temps : sa modification gagne toujours (le
   * départ / l'arrivée reprenaient les coordonnées de l'import).
   */
  const applyResolvedNames = useCallback(
    (itineraryId: string, resolved: ReadonlyArray<{ item: TimelineItem; name: string | null }>) => {
      const byId = new Map(resolved.filter((entry) => entry.name).map((entry) => [entry.item.id, entry]));
      if (byId.size === 0) return;
      setProject((projectState) => {
        let changed = false;
        const itineraries = projectState.itineraries.map((itinerary) => {
          if (itinerary.id !== itineraryId) return itinerary;
          const timeline = itinerary.timeline.map((item) => {
            const entry = byId.get(item.id);
            if (!entry) return item;
            const imported = entry.item;
            if (item.kind !== imported.kind || item.label !== imported.label || item.lat !== imported.lat || item.lon !== imported.lon) {
              return item;
            }
            changed = true;
            return { ...item, label: entry.name! };
          });
          return changed ? { ...itinerary, timeline } : itinerary;
        });
        return changed ? { ...projectState, itineraries } : projectState;
      });
    },
    [setProject],
  );

  const hydrateImportedTimelineNames = useCallback(
    async (itineraryId: string, importedTimeline: Itinerary['timeline']) => {
      const located = importedTimeline.filter((item) => item.lat != null && item.lon != null);
      const endpoints = located.filter((item) => item.kind === 'start' || item.kind === 'end');
      // Les points de passage nommés dans le GPX gardent leur nom.
      const waypoints = located.filter(
        (item) => item.kind === 'waypoint' && !item.id.startsWith(GPX_IMPORT_WAYPOINT_ID_PREFIX),
      );

      // Départ / arrivée d'abord, sans attendre les points de passage.
      applyResolvedNames(itineraryId, await Promise.all(endpoints.map(async (item) => ({
        item,
        name: await resolveImportedTimelineLabel(item.lon!, item.lat!),
      }))));

      applyResolvedNames(itineraryId, await Promise.all(waypoints.map(async (item) => {
        try {
          const settlement = await reverseGeocodeSettlement(item.lon!, item.lat!, { maxDistanceMeters: 1500 });
          return { item, name: settlement?.name?.trim() || null };
        } catch {
          return { item, name: null };
        }
      })));
    },
    [applyResolvedNames],
  );

  /**
   * Revêtements de la trace importée (BRouter, plusieurs dizaines de secondes
   * sur un ultra), reportés sur la trace COURANTE et seulement si sa géométrie
   * est celle analysée : remplacer les points par ceux de l'import effaçait
   * toute modification faite pendant l'analyse (tracé déplacé, rogné ou
   * rerouté, altitudes affinées, qualité de simplification changée).
   */
  const enrichImportedRouteSurfaces = useCallback(
    async (itineraryId: string, storedPoints: NonNullable<Itinerary['gpxRoute']>['points']) => {
      try {
        const analyzedGeometry = buildRouteGeometrySignature(storedPoints);
        const result = await analyzeGpxSurfaces(storedPoints);
        const hasSurfaces =
          result.metrics != null ||
          result.points.some((p) => p.surface && p.surface !== 'unknown');

        if (!hasSurfaces) return;

        setProject((projectState) => {
          let changed = false;
          const itineraries = projectState.itineraries.map((itinerary) => {
            if (itinerary.id !== itineraryId) return itinerary;
            const currentRoute = itinerary.gpxRoute;
            const currentPoints = currentRoute?.originalPoints;
            if (!currentRoute || !currentPoints || buildRouteGeometrySignature(currentPoints) !== analyzedGeometry) {
              return itinerary;
            }

            // Même géométrie, donc mêmes points dans le même ordre que l'analyse.
            const enrichedStoredPoints = normalizeImportedRoutePoints(
              currentPoints.map((point, index) => ({ ...point, surface: result.points[index]?.surface ?? point.surface })),
              { includeGradient: false },
            );
            const enrichedSimplifiedPoints = normalizeImportedRoutePoints(
              simplifyPointsByQuality(enrichedStoredPoints, currentRoute.gpxQuality ?? 'default', currentRoute.gpxQualityPointsPerKm),
            );
            const surfaceMetrics =
              result.metrics ?? computeRouteSurfaceMetricsFromPoints(enrichedStoredPoints);
            changed = true;

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
          });
          return changed ? { ...projectState, itineraries } : projectState;
        });
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
          void hydrateImportedTimelineNames(id, timeline);
          void enrichImportedRouteSurfaces(id, storedPoints);
        }
      } finally {
        onImportStateChange?.(null);
      }
    },
    [
      addItinerary,
      enrichImportedRouteSurfaces,
      hydrateImportedTimelineNames,
      onImportStateChange,
      onItineraryImported,
      setPendingCorridorFor,
      setProject,
    ],
  );

  return { addItineraryFromGpxFile };
}

