import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib';

import {
  clearForbiddenZoneDraft,
  clearForbiddenZones,
  clearRouteAuditFindings,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  setForbiddenZones,
  stackActiveRouteOnTop,
  type RouteSlopeBand,
  upsertRouteLayer,
} from '../lib/route-layer';
import { buildRouteContentSignature } from '../lib/routes';
import { getRouteElevationContext } from '../lib/route-layer/routeElevation';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '../lib/route-layer/constants';
import { resolveRouteDisplayPoints, resolveRouteDisplayPreset } from '../lib/route-layer/displayQuality';
import type { ItineraryProject, RouteDisplayQuality, RouteRenderMode, RouteSurfaceFilter } from '../types';
import { useRouteDisplayContext } from './useRouteDisplayContext';

function canAccessStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

// Fenêtre d'anti-rebond pour regrouper les rafales d'événements styledata. La
// trace lit son altitude sur le terrain côté GPU : les tuiles DEM arrivant en
// flux n'exigent jamais de rejeu.
const REPLAY_DEBOUNCE_MS = 120;
const REPLAY_RETRY_MS = 250;
const REPLAY_MAX_RETRIES = 40;

interface UseItineraryRouteLayerSyncArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
  routeTraceWidthPx?: number;
  /** Finesse des traces dessinées (vue) ; `auto` suit la 2D / 3D et le relief. */
  routeDisplayQuality?: RouteDisplayQuality;
  /** À false, toute la section Tracés est coupée et AUCUNE trace n'est rendue. */
  routesEnabled?: boolean;
  /** Filtre « Surface » du panneau d'analyse. */
  surfaceFilter?: RouteSurfaceFilter;
  /**
   * Filtre « Pente » du graphe central : cet itinéraire est tracé en pente
   * (même échelle que le profil), quel que soit son mode de rendu.
   */
  slopeItineraryId?: string | null;
}

function resolveRenderMode(
  itinerary: ItineraryProject['itineraries'][number],
  slopeItineraryId: string | null,
): RouteRenderMode {
  if (slopeItineraryId != null && itinerary.id === slopeItineraryId) return 'slope';
  return itinerary.renderMode ?? 'default';
}

export function useItineraryRouteLayerSync({
  active,
  isMapLoaded,
  itineraries,
  map,
  routeTraceWidthPx = DEFAULT_ROUTE_TRACE_WIDTH_PX,
  routeDisplayQuality = 'auto',
  routesEnabled = true,
  surfaceFilter = 'all',
  slopeItineraryId = null,
}: UseItineraryRouteLayerSyncArgs): void {
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceReplayPendingRef = useRef(false);
  // Signature de la dernière fois où des données ont vraiment été poussées vers
  // la carte. Quand styledata / sourcedata se déclenchent sans que cette
  // signature change, le rejeu ne fait rien (la géométrie / le style du tracé
  // n'a pas changé — seul le terrain a changé).
  const lastReplayedSignatureRef = useRef<string | null>(null);

  const routeSlopeBands = useMemo(
    (): RouteSlopeBand[] => ROUTE_SLOPE_LEGEND_BANDS.map((band) => ({
      id: band.id,
      minDeg: band.minDeg,
      maxDeg: band.maxDeg,
      color: band.color,
    })),
    [],
  );
  const displayContext = useRouteDisplayContext(map);
  const routeDisplayPreset = resolveRouteDisplayPreset(routeDisplayQuality, displayContext);
  const routeSlopeBandSignature = useMemo(
    () => routeSlopeBands.map((band) => `${band.id}:${band.minDeg}:${band.maxDeg}:${band.color}`).join('|'),
    [routeSlopeBands],
  );
  const layerSignature = useMemo(() => {
    const itinerarySignature = itineraries
      .map((it) => {
        const len = it.gpxRoute?.points.length ?? 0;
        const routeKey = buildRouteContentSignature(it.gpxRoute?.points);
        return [
          it.id,
          len,
          it.gpxRoute?.originalPoints?.length ?? 0,
          routeKey,
          it.color,
          it.opacity ?? 100,
          resolveRenderMode(it, slopeItineraryId),
          routeTraceWidthPx,
          it.visible !== false ? 1 : 0,
          it.analysisVisible !== false ? 1 : 0,
          (it.forbiddenZones ?? []).map((zone) => {
            const first = zone.points[0];
            return `${zone.id}:${zone.points.length}:${first?.lon ?? ''}:${first?.lat ?? ''}`;
          }).join(','),
        ].join(':');
      })
      .join('|');
    return `${routesEnabled ? 1 : 0}::active:${active?.id ?? ''}::${itinerarySignature}::bands:${routeSlopeBandSignature}::surface:${surfaceFilter}::quality:${routeDisplayPreset}`;
  }, [active?.id, itineraries, routeDisplayPreset, routeSlopeBandSignature, routeTraceWidthPx, routesEnabled, slopeItineraryId, surfaceFilter]);

  // Sac de refs pour que les écouteurs de carte stables lisent toujours les
  // dernières valeurs sans se réabonner à chaque modification du projet.
  // Synchronisé dans un effet de mise en page, donc avant tout effet passif ci-dessous.
  const latestState = {
    active,
    isMapLoaded,
    itineraries,
    map,
    routeSlopeBands,
    routeTraceWidthPx,
    routeDisplayPreset,
    routesEnabled,
    surfaceFilter,
    slopeItineraryId,
    layerSignature,
  };
  const stateRef = useRef(latestState);
  useLayoutEffect(() => {
    stateRef.current = latestState;
  });

  const replayRouteState = useCallback((force = false): boolean => {
    const {
      map: currentMap,
      isMapLoaded: loaded,
      itineraries: currentItineraries,
      active: currentActive,
      routeSlopeBands: bands,
      routeTraceWidthPx: traceWidthPx,
      routeDisplayPreset: displayPreset,
      layerSignature: signature,
      routesEnabled: areRoutesEnabled,
      surfaceFilter: activeSurfaceFilter,
      slopeItineraryId: currentSlopeItineraryId,
    } = stateRef.current;
    if (!currentMap || !loaded || !canAccessStyle(currentMap)) return false;

    // Élevé (terrain, Mercator) ou drapé (globe / sans terrain) : la référence
    // d'élévation des couches de ligne le suit. Les tuiles DEM en flux ne comptent jamais.
    const renderSignature = `${signature}::elevation:${getRouteElevationContext(currentMap).signature}`;
    if (!force && lastReplayedSignatureRef.current === renderSignature) return true;

    let allMounted = true;
    for (const it of currentItineraries) {
      const route = it.gpxRoute;
      if (!route || route.points.length < 2) continue;
      const pts = resolveRouteDisplayPoints(route, displayPreset);
      // Visible ssi la section Tracés est active ET que l'utilisateur n'a pas
      // explicitement masqué cette trace. (`analysisVisible` pilote le
      // graphique/profil central, pas la ligne sur la carte.)
      const routeVisible = areRoutesEnabled && it.visible !== false;
      try {
        const mounted = upsertRouteLayer(currentMap, it.id, pts, {
          color: it.color,
          opacity01: (it.opacity ?? 100) / 100,
          traceWidthPx,
          visible: routeVisible,
          renderMode: resolveRenderMode(it, currentSlopeItineraryId),
          slopeBands: bands,
          surfaceFilter: activeSurfaceFilter,
        });
        if (!mounted) allMounted = false;
      } catch (error) {
        allMounted = false;
        console.warn('[route-layer] upsert failed for', it.id, error);
      }
    }

    for (const mountedId of listMountedRouteIds(currentMap)) {
      const stillWanted = currentItineraries.some(
        (it) =>
          it.id.replace(/[^a-zA-Z0-9_-]/g, '_') === mountedId &&
          it.gpxRoute &&
          it.gpxRoute.points.length >= 2,
      );
      if (!stillWanted) {
        removeRouteLayer(currentMap, mountedId);
      }
    }

    // Le tracé sélectionné par-dessus les autres (variantes superposées).
    if (currentActive) {
      stackActiveRouteOnTop(
        currentMap,
        currentActive.id,
        currentItineraries.filter((it) => (it.gpxRoute?.points.length ?? 0) >= 2).map((it) => it.id),
      );
    }

    clearRouteAuditFindings(currentMap);
    if (currentActive && areRoutesEnabled) {
      setForbiddenZones(currentMap, currentActive.forbiddenZones ?? []);
    } else {
      clearForbiddenZones(currentMap);
      clearForbiddenZoneDraft(currentMap);
    }

    // Une trace que le style n'a pas encore pu prendre est retentée au prochain
    // événement / minuteur au lieu d'être considérée comme faite.
    lastReplayedSignatureRef.current = allMounted ? renderSignature : null;
    return allMounted;
  }, []);

  const scheduleReplayRouteState = useCallback((force = false): void => {
    if (force) forceReplayPendingRef.current = true;
    // Déjà programmé — le minuteur en attente reprendra le drapeau `force`.
    if (replayTimerRef.current) return;
    const run = (attempt: number): void => {
      replayTimerRef.current = setTimeout(() => {
        replayTimerRef.current = null;
        const pendingForce = forceReplayPendingRef.current;
        forceReplayPendingRef.current = false;
        if (replayRouteState(pendingForce) || attempt >= REPLAY_MAX_RETRIES) return;
        // Le style a refusé une trace (en cours de remplacement) : réessayer aussi
        // sur minuteur, une carte au repos peut ne plus émettre d'événement avant longtemps.
        if (pendingForce) forceReplayPendingRef.current = true;
        run(attempt + 1);
      }, attempt === 0 ? REPLAY_DEBOUNCE_MS : REPLAY_RETRY_MS);
    };
    run(0);
  }, [replayRouteState]);

  // Rejouer chaque fois que l'état réel du tracé (points / couleurs / visibilité) change.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!replayRouteState()) scheduleReplayRouteState();
  }, [isMapLoaded, layerSignature, map, replayRouteState, scheduleReplayRouteState]);

  // Écouteurs de carte stables : abonnement une fois par (map, isMapLoaded). Ils
  // lisent le dernier état via des refs, ils ne se détachent/réattachent donc pas
  // à chaque modification du projet — ce qui provoquait une tempête de
  // réabonnements pendant l'import GPX.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      try {
        removeAllRouteLayers(map);
        clearRouteAuditFindings(map);
        clearForbiddenZones(map);
        clearForbiddenZoneDraft(map);
      } catch {
        /* noop */
      }
      // Les couches ont été effacées — le prochain rejeu DOIT tout repousser quelle
      // que soit la signature : vider le cache et forcer.
      lastReplayedSignatureRef.current = null;
      scheduleReplayRouteState(true);
    };
    const onStyleData = () => {
      scheduleReplayRouteState(false);
    };
    // Les lignes élevées ne sont pas dessinées sur le globe : basculer les couches
    // dès que le zoom franchit ROUTE_ELEVATED_MIN_ZOOM, pas après zoomend + anti-rebond
    // (un dézoom laissait toute la trace invisible jusque-là).
    let lastElevated = getRouteElevationContext(map).elevated;
    const onZoom = () => {
      const elevated = getRouteElevationContext(map).elevated;
      if (elevated === lastElevated) return;
      lastElevated = elevated;
      if (!replayRouteState()) scheduleReplayRouteState();
    };
    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleData);
    map.on('zoomend', onStyleData);
    map.on('zoom', onZoom);
    map.on('terrain', onStyleData);
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      forceReplayPendingRef.current = false;
      map.off('style.load', onStyleLoad);
      map.off('styledata', onStyleData);
      map.off('zoomend', onStyleData);
      map.off('zoom', onZoom);
      map.off('terrain', onStyleData);
    };
  }, [isMapLoaded, map, replayRouteState, scheduleReplayRouteState]);
}
