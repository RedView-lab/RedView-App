// POI engine hook — fetches POIs along the active GPX corridor and renders
// them as 3D DOM markers on the Mapbox map.
//
// Rendering is delegated to `PoiMarkerManager` (lib/poi-markers.ts), which
// uses `mapboxgl.Marker` DOM overlays instead of symbol layers. DOM markers
// survive style reloads and are immune to the symbol-placement/terrain
// occlusion culling that previously made POIs invisible on the 3D map, so
// this hook no longer needs any `styledata` resynchronisation, sprite
// registration or source/layer lifecycle management.
//
// Filtering policy — EXHAUSTIVE BY DESIGN:
//   The only filter applied is the one the user configures: for each
//   category, keep every POI whose lateral distance to the track is <= the
//   X metres set in the POI panel. There is deliberately NO density cap, NO
//   "top N per km" shortlist, NO opening-hours exclusion and NO zoom-based
//   culling any more — the map must show *all* the POIs that exist within
//   the requested distance. See lib/corridor-distance-filter.ts.

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { PoiCategory, PoiFeature, GpxRoute } from '../types';
import { fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { sampleRouteByDistance } from '../lib/gpx-loader';
import { filterPoisByLateralDistance } from '../lib/corridor-distance-filter';
import { PoiMarkerManager } from '../lib/poi-markers';
import type { UsePoiPopupActions } from '../lib/poi-popup';
import { matchesPoiCategory } from '@/features/itineraryPanel/sections/timeline/poiCategoryMatch';
import '../styles/floating-markers.css';

// Re-exported so existing consumers keep importing from the hook module.
export type { PoiPopupState, UsePoiPopupActions } from '../lib/poi-popup';

export function usePoi(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabledCategories: Set<PoiCategory>,
  gpxRoute: GpxRoute | null = null,
  radiusM: number = 1000,
  maxLateralDistanceByCategory: Partial<Record<PoiCategory, number>> | null = null,
  onCorridorUpdate?: (features: PoiFeature[]) => void,
  onCorridorComplete?: (features: PoiFeature[]) => void,
  /**
   * Pre-loaded POI features to render immediately (e.g. rehydrated from
   * a saved project). Seeds the marker registry so itinerary switches
   * restore markers without re-running the corridor search.
   */
  initialFeatures: PoiFeature[] | null = null,
  popupActions: UsePoiPopupActions = {},
  routeId: string | null = null,
  poisRouteEnabled: boolean = true,
  favorisEnabled: boolean = true,
  selectedPoiCategories?: Set<string>,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poiCount, setPoiCount] = useState(0);
  /** 0..1 progress for corridor fetches; null when not running. */
  const [corridorProgress, setCorridorProgress] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const managerRef = useRef<PoiMarkerManager | null>(null);
  const lastCorridorFeatures = useRef<PoiFeature[]>([]);

  // Mirror reactive inputs into refs so stable callbacks read fresh values.
  const enabledRef = useRef(enabledCategories);
  enabledRef.current = enabledCategories;
  const favorisEnabledRef = useRef(favorisEnabled);
  favorisEnabledRef.current = favorisEnabled;
  const poisRouteEnabledRef = useRef(poisRouteEnabled);
  poisRouteEnabledRef.current = poisRouteEnabled;
  const selectedPoiCategoriesRef = useRef(selectedPoiCategories);
  selectedPoiCategoriesRef.current = selectedPoiCategories;
  const gpxRef = useRef(gpxRoute);
  gpxRef.current = gpxRoute;
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;
  const maxLateralDistanceByCategoryRef = useRef(maxLateralDistanceByCategory);
  maxLateralDistanceByCategoryRef.current = maxLateralDistanceByCategory;
  const onCorridorUpdateRef = useRef(onCorridorUpdate);
  onCorridorUpdateRef.current = onCorridorUpdate;
  const onCorridorCompleteRef = useRef(onCorridorComplete);
  onCorridorCompleteRef.current = onCorridorComplete;
  const popupActionsRef = useRef<UsePoiPopupActions>(popupActions);
  popupActionsRef.current = popupActions;
  const initialFeaturesRef = useRef<PoiFeature[] | null>(initialFeatures);
  initialFeaturesRef.current = initialFeatures;

  // Stable dependency keys for effects that react to semantic changes.
  const enabledCategoriesKey = Array.from(enabledCategories).sort().join('|');
  const selectedPoiCategoriesKey = selectedPoiCategories
    ? Array.from(selectedPoiCategories).sort().join('|')
    : 'all';
  const lateralDistanceKey = maxLateralDistanceByCategory
    ? Object.entries(maxLateralDistanceByCategory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, distance]) => `${category}:${distance}`)
      .join('|')
    : 'off';
  // Identity of the itinerary's saved features: a change signals an
  // itinerary switch or a favorite toggle and prompts a marker rehydration.
  const initialFeaturesKey = initialFeatures && initialFeatures.length > 0
    ? initialFeatures.map((feature) => [
      feature.id,
      feature.category,
      feature.favorite ? '1' : '0',
      feature.lat,
      feature.lon,
    ].join(':')).join('|')
    : 'empty';

  // ── Feature filtering ─────────────────────────────────────────────
  //
  // Two passes only, both of them user-controlled:
  //   1. category is enabled in the POI panel / top filter bar,
  //   2. lateral distance to the track <= the X metres set for that
  //      category.
  // Favorites are rendered ONLY if `favorisEnabled` is true (and category matches).
  // Non-favorites are rendered ONLY if `poisRouteEnabled` is true (and category matches).

  const buildRenderableFeatures = useCallback((features: PoiFeature[]) => {
    if (features.length === 0) return [];

    const matchesCategory = (category: PoiCategory) => {
      const activeCats = selectedPoiCategoriesRef.current;
      if (!activeCats || activeCats.size === 0) return true;
      return matchesPoiCategory(category, activeCats);
    };

    const isFavEnabled = favorisEnabledRef.current;
    const isRoutePoisEnabled = poisRouteEnabledRef.current;

    const favorites = isFavEnabled
      ? features.filter((feature) => feature.favorite && matchesCategory(feature.category))
      : [];
    const nonFavorites = isRoutePoisEnabled
      ? features.filter(
          (feature) =>
            !feature.favorite &&
            enabledRef.current.has(feature.category) &&
            matchesCategory(feature.category),
        )
      : [];

    if (favorites.length === 0 && nonFavorites.length === 0) return [];

    const route = gpxRef.current;
    if (!route || route.points.length < 2) return [...favorites, ...nonFavorites];

    const filteredNonFavorites = filterPoisByLateralDistance(
      nonFavorites,
      route.points,
      maxLateralDistanceByCategoryRef.current ?? undefined,
    );

    return [...favorites, ...filteredNonFavorites];
  }, []);

  const syncRenderedFeatures = useCallback((features: PoiFeature[]) => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.sync(features);
    setPoiCount(features.length);
  }, []);

  // ── Corridor fetch (along GPX route, chunked & progressive) ───────

  const fetchCorridorPois = useCallback(async () => {
    const route = gpxRef.current;
    const cats = Array.from(enabledRef.current);
    if (!route || cats.length === 0 || !poisRouteEnabledRef.current) {
      const all = initialFeaturesRef.current ?? [];
      lastCorridorFeatures.current = all;
      syncRenderedFeatures(buildRenderableFeatures(all));
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setCorridorProgress(0);

    // Spacing chosen so consecutive radius disks OVERLAP, which is the only
    // way to get *every* POI within `radius` of the track:
    //   1. spacing = radius * 1.4  → strictly < 2 * radius, so adjacent
    //      disks always intersect and no slice of the corridor is skipped.
    //      (The previous `max(200, radius * 1.6)` floor silently broke this
    //      for any radius < 125 m — with the shipped 40 m default it left a
    //      120 m blind gap between two 40 m disks, i.e. ~80 % of the route
    //      was never queried.)
    //   2. spacing >= 10 m         → bounds the sample count for tiny radii.
    //   3. spacing >= length/8000  → keeps the POST body under the proxy
    //      limit for very long routes (multi-day tours).
    const radius = radiusRef.current;
    let approxLenM = 0;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      const dLat = (b.lat - a.lat) * 111_320;
      const dLon =
        (b.lon - a.lon) *
        111_320 *
        Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
      approxLenM += Math.sqrt(dLat * dLat + dLon * dLon);
    }
    const lenBasedSpacing = approxLenM > 0 ? approxLenM / 8_000 : 0;
    const spacing = Math.max(10, radius * 1.4, lenBasedSpacing);
    const sampled = sampleRouteByDistance(route.points, spacing, 8_000);

    try {
      const features = await fetchPoisAlongRouteChunked({
        samples: sampled,
        radiusM: radius,
        categories: cats,
        signal: controller.signal,
        onProgress: (deduped, { done, total }) => {
          if (controller.signal.aborted) return;
          const all = [...(initialFeaturesRef.current ?? []), ...deduped];
          lastCorridorFeatures.current = all;
          const rendered = buildRenderableFeatures(all);
          syncRenderedFeatures(rendered);
          onCorridorUpdateRef.current?.(rendered);
          setCorridorProgress(total > 0 ? done / total : 0);
        },
      });
      if (!controller.signal.aborted) {
        const all = [...(initialFeaturesRef.current ?? []), ...features];
        lastCorridorFeatures.current = all;
        const rendered = buildRenderableFeatures(all);
        syncRenderedFeatures(rendered);
        onCorridorCompleteRef.current?.(rendered);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Erreur POI corridor');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setCorridorProgress(null);
      }
    }
  }, [buildRenderableFeatures, syncRenderedFeatures]);

  // ── Public triggers ───────────────────────────────────────────────

  const searchCorridor = useCallback(() => {
    if (managerRef.current && gpxRef.current) {
      void fetchCorridorPois();
    }
  }, [fetchCorridorPois]);

  const cancelSearchCorridor = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setCorridorProgress(null);
    setError(null);
  }, []);

  // ── Marker manager lifecycle ──────────────────────────────────────

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const manager = new PoiMarkerManager(map, () => popupActionsRef.current);
    managerRef.current = manager;

    const all = initialFeaturesRef.current ?? [];
    lastCorridorFeatures.current = all;
    const seed = buildRenderableFeatures(all);
    manager.sync(seed);
    setPoiCount(seed.length);

    return () => {
      abortRef.current?.abort();
      managerRef.current = null;
      manager.destroy();
      setPoiCount(0);
    };
  }, [map, isMapLoaded, buildRenderableFeatures]);

  // ── Route switch lifecycle ────────────────────────────────────────

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setCorridorProgress(null);
    setError(null);
    if (!managerRef.current) return;
    const all = initialFeaturesRef.current ?? [];
    lastCorridorFeatures.current = all;
    const seed = buildRenderableFeatures(all);
    syncRenderedFeatures(seed);
    setPoiCount(seed.length);
  }, [routeId, buildRenderableFeatures, syncRenderedFeatures]);

  // ── React to category / distance / filter changes ─────────────────

  useEffect(() => {
    if (!managerRef.current) return;
    // In corridor mode a settings change re-runs the search; otherwise the
    // saved features are simply re-filtered.
    if (gpxRef.current && poisRouteEnabled && lastCorridorFeatures.current.length > 0) {
      void fetchCorridorPois();
      return;
    }

    const source =
      lastCorridorFeatures.current.length > 0
        ? lastCorridorFeatures.current
        : (initialFeaturesRef.current ?? []);
    syncRenderedFeatures(buildRenderableFeatures(source));
  }, [
    map,
    isMapLoaded,
    enabledCategoriesKey,
    lateralDistanceKey,
    favorisEnabled,
    poisRouteEnabled,
    selectedPoiCategoriesKey,
    fetchCorridorPois,
    buildRenderableFeatures,
    syncRenderedFeatures,
  ]);

  // ── Rehydrate when the active itinerary's saved features change ───

  useEffect(() => {
    if (!managerRef.current) return;
    const all = initialFeaturesRef.current ?? [];
    lastCorridorFeatures.current = all;
    const seed = buildRenderableFeatures(all);
    syncRenderedFeatures(seed);
  }, [map, isMapLoaded, initialFeaturesKey, buildRenderableFeatures, syncRenderedFeatures]);

  const openPoiMarker = useCallback(
    (poiId: number | string, category?: string, coords?: { lat: number; lon: number }) => {
      return managerRef.current?.openPoi(poiId, category, coords) ?? false;
    },
    [],
  );

  return {
    loading,
    error,
    poiCount,
    corridorProgress,
    searchCorridor,
    cancelSearchCorridor,
    openPoiMarker,
  };
}
