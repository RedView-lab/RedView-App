// POI engine hook — fetches POIs along the active GPX corridor and renders
// them as 3D DOM markers on the Mapbox map.
//
// Rendering is delegated to `PoiMarkerManager` (lib/poi-markers.ts), which
// uses `mapboxgl.Marker` DOM overlays instead of symbol layers. DOM markers
// survive style reloads and are immune to the symbol-placement/terrain
// occlusion culling that previously made POIs invisible on the 3D map, so
// this hook no longer needs any `styledata` resynchronisation, sprite
// registration or source/layer lifecycle management.

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { PoiCategory, PoiFeature, GpxRoute } from '../types';
import { fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { sampleRouteByDistance } from '../lib/gpx-loader';
import { refinePoiFeaturesAlongRoute } from '../lib/refine-corridor-pois';
import { PoiMarkerManager } from '../lib/poi-markers';
import type { UsePoiPopupActions } from '../lib/poi-popup';
import '../styles/floating-markers.css';

// Re-exported so existing consumers keep importing from the hook module.
export type { PoiPopupState, UsePoiPopupActions } from '../lib/poi-popup';

export function usePoi(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabledCategories: Set<PoiCategory>,
  gpxRoute: GpxRoute | null = null,
  radiusM: number = 1000,
  refineMaxPerCategoryPerKm: number | null = null,
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
  const gpxRef = useRef(gpxRoute);
  gpxRef.current = gpxRoute;
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;
  const refineMaxRef = useRef(refineMaxPerCategoryPerKm);
  refineMaxRef.current = refineMaxPerCategoryPerKm;
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
  const refineKey = refineMaxPerCategoryPerKm ? String(refineMaxPerCategoryPerKm) : 'off';
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

  // ── Feature filtering / refinement ────────────────────────────────

  const buildRenderableFeatures = useCallback((features: PoiFeature[]) => {
    if (features.length === 0 || enabledRef.current.size === 0) return [];

    const filtered = features.filter((feature) => enabledRef.current.has(feature.category));
    if (filtered.length === 0) return [];

    const route = gpxRef.current;
    const maxPerCategoryPerKm = refineMaxRef.current;
    if (!route || !maxPerCategoryPerKm) return filtered;

    return refinePoiFeaturesAlongRoute(filtered, route.points, {
      maxPerCategoryPerKm,
      windowM: 1_000,
      maxLateralDistanceByCategory: maxLateralDistanceByCategoryRef.current ?? undefined,
    });
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
    if (!route || cats.length === 0) {
      lastCorridorFeatures.current = [];
      syncRenderedFeatures([]);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setCorridorProgress(0);

    // Spacing chosen so consecutive `around:r` disks overlap (no corridor
    // gaps) under three constraints:
    //   1. spacing >= radius * 1.6  → adjacent disks overlap.
    //   2. spacing >= 200 m         → tiny user radii still produce a
    //      reasonable sample count (avoids 10 000+ samples for 40 m).
    //   3. total samples never exceed ~1500 → caps sequential POI-server
    //      chunks for huge GPX routes (multi-day tours) at ~20 calls.
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
    const lenBasedSpacing = approxLenM > 0 ? approxLenM / 1_500 : 0;
    const spacing = Math.max(200, radius * 1.6, lenBasedSpacing);
    const sampled = sampleRouteByDistance(route.points, spacing, 8_000);

    try {
      const features = await fetchPoisAlongRouteChunked({
        samples: sampled,
        radiusM: radius,
        categories: cats,
        signal: controller.signal,
        onProgress: (deduped, { done, total }) => {
          if (controller.signal.aborted) return;
          const rendered = buildRenderableFeatures(deduped);
          lastCorridorFeatures.current = rendered;
          syncRenderedFeatures(rendered);
          onCorridorUpdateRef.current?.(rendered);
          setCorridorProgress(total > 0 ? done / total : 0);
        },
      });
      if (!controller.signal.aborted) {
        const rendered = buildRenderableFeatures(features);
        lastCorridorFeatures.current = rendered;
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

    const seed = buildRenderableFeatures(initialFeaturesRef.current ?? []);
    lastCorridorFeatures.current = seed;
    manager.sync(seed);
    setPoiCount(seed.length);

    return () => {
      abortRef.current?.abort();
      managerRef.current = null;
      manager.destroy();
      setPoiCount(0);
    };
  }, [map, isMapLoaded, buildRenderableFeatures]);

  // ── React to category / refinement changes ────────────────────────

  useEffect(() => {
    if (!managerRef.current) return;
    // In corridor mode a settings change re-runs the search; otherwise the
    // saved features are simply re-filtered.
    if (gpxRef.current && lastCorridorFeatures.current.length > 0) {
      void fetchCorridorPois();
      return;
    }

    syncRenderedFeatures(buildRenderableFeatures(initialFeaturesRef.current ?? []));
  }, [map, isMapLoaded, enabledCategoriesKey, refineKey, lateralDistanceKey, fetchCorridorPois, buildRenderableFeatures, syncRenderedFeatures]);

  // ── Rehydrate when the active itinerary's saved features change ───

  useEffect(() => {
    if (!managerRef.current) return;
    const seed = buildRenderableFeatures(initialFeaturesRef.current ?? []);
    lastCorridorFeatures.current = seed;
    syncRenderedFeatures(seed);
  }, [map, isMapLoaded, initialFeaturesKey, buildRenderableFeatures, syncRenderedFeatures]);

  return { loading, error, poiCount, corridorProgress, searchCorridor, cancelSearchCorridor };
}
