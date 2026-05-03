import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { usePoi } from '@/features/poi/hooks/usePoi';
import { buildRouteContentSignature } from '@/features/itineraryPanel/lib/routes';
import {
  addGpxRoute,
  fitMapToRoute,
  isGpxRouteOnMap,
  raiseGpxRoute,
  removeGpxRoute,
} from '@/features/poi/lib/gpx-layer';
import type {
  PoiCategory as FeaturePoiCategory,
  PoiFeature,
} from '@/features/poi/types';

import type {
  Itinerary,
  PoiCategory as PanelPoiCategory,
  PoiEntry,
} from '../types';

/**
 * Mapping from the panel's per-row POI keys (Figma taxonomy) to the
 * underlying OSM/Overpass categories used by the POI engine.
 *
 * Empty arrays mean the row is shown in the UI but not yet wired to
 * an OSM tag — the corridor search will simply ignore it.
 */
const PANEL_TO_FEATURE_POI: Record<PanelPoiCategory, FeaturePoiCategory[]> = {
  fountains: ['drinking_water'],
  toilets: ['toilets'],
  supermarkets: ['supermarket', 'convenience'],
  gasStations: ['fuel'],
  bakeries: ['bakery'],
  fastFood: ['fast_food'],
  cafes: ['cafe'],
  bars: ['bar'],
  restaurants: ['restaurant'],
  bikeShops: ['bicycle', 'bicycle_repair'],
  hotels: ['hotel'],
  refuges: ['alpine_hut', 'shelter', 'camp_site'],
  passes: [],
};

const DEFAULT_RADIUS_M = 1000;
const DEFAULT_REFINE_LIMIT_PER_KM = 4;
const POI_NON_ENTRY_KEYS = new Set(['refineResults', 'refineLimitPerKm']);

function buildRenderedRouteKey(
  itineraryId: string | null,
  points: { lat: number; lon: number }[] | null | undefined,
): string {
  if (!points || points.length === 0) return itineraryId ? `${itineraryId}:empty` : 'empty';
  return `${itineraryId ?? 'no-itinerary'}:${buildRouteContentSignature(points)}`;
}

export interface UseItineraryPoiMapResult {
  loading: boolean;
  error: string | null;
  poiCount: number;
  /** 0..1 corridor-search progress; null while idle. */
  corridorProgress: number | null;
  /** Trigger a corridor search along the active itinerary's GPX route. */
  searchCorridor: () => void;
  hasGpxRoute: boolean;
  hasEnabledCategories: boolean;
  /** Effective radius (max of enabled rows) used by the corridor search. */
  radiusM: number;
}

/**
 * Bridges the left-dock Itinerary Panel's POI editor with the Mapbox map:
 *
 * - Renders the active itinerary's GPX track as a styled line.
 * - Translates the panel's POI rows into Overpass categories.
 * - Forwards loading / count / error state back to the panel.
 *
 * The hook is intentionally side-effect-only on the map; it never owns
 * UI state beyond what `usePoi` already exposes.
 */
export function useItineraryPoiMap(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  active: Itinerary | null,
  onCorridorUpdate?: (features: PoiFeature[]) => void,
  onCorridorComplete?: (features: PoiFeature[]) => void,
): UseItineraryPoiMapResult {
  // ── Derive enabled OSM categories from the panel POI rows ─────────
  const enabledCategories = useMemo<Set<FeaturePoiCategory>>(() => {
    const set = new Set<FeaturePoiCategory>();
    if (!active) return set;
    for (const [panelKey, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(panelKey)) continue;
      const entry = raw as PoiEntry;
      if (!entry.enabled) continue;
      const mapped = PANEL_TO_FEATURE_POI[panelKey as PanelPoiCategory] ?? [];
      for (const fk of mapped) set.add(fk);
    }
    return set;
  }, [active]);

  // ── Effective corridor radius: max of enabled rows ────────────────
  const radiusM = useMemo(() => {
    if (!active) return DEFAULT_RADIUS_M;
    let max = 0;
    for (const [k, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(k)) continue;
      const entry = raw as PoiEntry;
      if (entry.enabled && entry.distanceM && entry.distanceM > max) {
        max = entry.distanceM;
      }
    }
    return max > 0 ? max : DEFAULT_RADIUS_M;
  }, [active]);

  const refineMaxPerCategoryPerKm = useMemo(() => {
    if (!active?.poi.refineResults) return null;
    return active.poi.refineLimitPerKm ?? DEFAULT_REFINE_LIMIT_PER_KM;
  }, [active]);

  const gpxRoute = active?.gpxRoute ?? null;
  const persistedPoiFeatures = active?.poiFeatures ?? null;
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderedRouteKeyRef = useRef<string | null>(null);
  const fittedRouteKeyRef = useRef<string | null>(null);
  const gpxRouteKey = useMemo(
    () => buildRenderedRouteKey(active?.id ?? null, gpxRoute?.points),
    [active?.id, gpxRoute?.points],
  );

  const { loading, error, poiCount, corridorProgress, searchCorridor } = usePoi(
    map,
    isMapLoaded,
    enabledCategories,
    gpxRoute,
    radiusM,
    refineMaxPerCategoryPerKm,
    onCorridorUpdate,
    onCorridorComplete,
    persistedPoiFeatures,
  );

  // ── Render the active itinerary's GPX track ───────────────────────
  // Skip when the route was synthesised from BRouter — the BRouter layer
  // already paints it, and stacking two lines would tint the colour.
  const gpxNeedsRender = gpxRoute && gpxRoute.source !== 'brouter';
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (gpxNeedsRender && gpxRoute) {
      try {
        if (!isGpxRouteOnMap(map) || renderedRouteKeyRef.current !== gpxRouteKey) {
          addGpxRoute(map, gpxRoute.points);
          renderedRouteKeyRef.current = gpxRouteKey;
        } else {
          raiseGpxRoute(map);
        }
        if (fittedRouteKeyRef.current !== gpxRouteKey) {
          fitMapToRoute(map, gpxRoute.points);
          fittedRouteKeyRef.current = gpxRouteKey;
        }
      } catch {
        /* map may be tearing down */
      }
    } else if (isGpxRouteOnMap(map)) {
      try {
        removeGpxRoute(map);
        renderedRouteKeyRef.current = null;
        fittedRouteKeyRef.current = null;
      } catch {
        /* noop */
      }
    }
  }, [map, isMapLoaded, gpxRoute, gpxNeedsRender, gpxRouteKey]);

  // Re-add the GPX after a Mapbox style.load (Standard Satellite fires
  // style.load multiple times as imports/terrain settle, wiping custom
  // layers). Defer so useMap's async setup completes first.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const replayGpxRoute = () => {
      if (!gpxNeedsRender || !gpxRoute) return;
      try {
        if (isGpxRouteOnMap(map)) {
          raiseGpxRoute(map);
        } else {
          addGpxRoute(map, gpxRoute.points);
          renderedRouteKeyRef.current = gpxRouteKey;
        }
      } catch {
        /* noop */
      }
    };
    const scheduleReplayGpxRoute = () => {
      if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
      replayTimerRef.current = setTimeout(() => {
        replayTimerRef.current = null;
        replayGpxRoute();
      }, 0);
    };
    const onStyleLoad = () => {
      scheduleReplayGpxRoute();
    };
    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleLoad);
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      map.off('style.load', onStyleLoad);
      map.off('styledata', onStyleLoad);
    };
  }, [map, isMapLoaded, gpxRoute, gpxNeedsRender, gpxRouteKey]);

  return {
    loading,
    error,
    poiCount,
    corridorProgress,
    searchCorridor,
    hasGpxRoute: gpxRoute !== null,
    hasEnabledCategories: enabledCategories.size > 0,
    radiusM,
  };
}
