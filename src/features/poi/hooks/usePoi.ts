// POI engine hook — fetches POIs along the active GPX corridor and renders
// them on the 3D Mapbox map.
//
// Rendering is delegated to `PoiMarkerManager` (lib/poi-markers.ts): one GPU
// symbol layer with pre-rasterised sprites, placement/occlusion culling
// disabled explicitly, and its own style-reload reinstall. This hook only
// feeds it the filtered feature list.
//
// Filtering policy — EXHAUSTIVE BY DESIGN:
//   The only filter applied is the one the user configures: for each
//   category, keep every POI whose lateral distance to the track is <= the
//   X metres set in the POI panel. There is deliberately NO density cap, NO
//   "top N per km" shortlist, NO opening-hours exclusion and NO zoom-based
//   culling any more — the map must show *all* the POIs that exist within
//   the requested distance. See lib/corridor-distance-filter.ts.

import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { PoiCategory, PoiFeature, GpxRoute } from '../types';
import { PoiApiError, clampCorridorRadiusM, fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { buildCorridorSamples } from '../lib/corridor-samples';
import { filterPoisByLateralDistance } from '../lib/corridor-distance-filter';
import { PoiMarkerManager } from '../lib/poi-markers';
import type { UsePoiPopupActions } from '../lib/poi-popup';
import { matchesPoiCategory } from '@/features/itineraryPanel/sections/timeline/poiCategoryMatch';
import '../styles/floating-markers.css';

// Re-exported so existing consumers keep importing from the hook module.
export type { PoiPopupState, UsePoiPopupActions } from '../lib/poi-popup';

function deduplicateFeatures(features: PoiFeature[] | null): PoiFeature[] {
  if (!features || features.length === 0) return [];
  const map = new Map<number | string, PoiFeature>();
  for (const f of features) {
    const existing = map.get(f.id);
    if (!existing) {
      map.set(f.id, { ...f });
    } else {
      existing.favorite = Boolean(existing.favorite || f.favorite);
      if (f.pauseDurationMin !== undefined) {
        existing.pauseDurationMin = f.pauseDurationMin;
      }
    }
  }
  return Array.from(map.values());
}

/**
 * Message affichable (texte source FR, traduit par le panneau) pour un échec
 * de la recherche corridor.
 */
function describeCorridorError(err: unknown): string {
  if (err instanceof PoiApiError && err.status === 413) {
    return 'Corridor trop large : réduisez le rayon ou découpez l’itinéraire';
  }
  if (err instanceof PoiApiError && err.status === 0) {
    return 'La recherche de POI a expiré. Les POI déjà trouvés sont conservés.';
  }
  return 'La recherche de POI a échoué. Les POI déjà trouvés sont conservés.';
}

function mergeCorridorWithSavedFeatures(
  freshFeatures: PoiFeature[],
  savedFeatures: PoiFeature[] | null,
): PoiFeature[] {
  const map = new Map<number | string, PoiFeature>();

  for (const feature of freshFeatures) {
    map.set(feature.id, { ...feature });
  }

  if (savedFeatures) {
    for (const saved of savedFeatures) {
      const existing = map.get(saved.id);
      if (existing) {
        existing.favorite = Boolean(saved.favorite);
        existing.pauseDurationMin = saved.pauseDurationMin ?? null;
        if (saved.favoriteSource) existing.favoriteSource = saved.favoriteSource;
        if (saved.autoReason) existing.autoReason = saved.autoReason;
      } else if (saved.favorite || (saved.pauseDurationMin != null && saved.pauseDurationMin > 0)) {
        map.set(saved.id, { ...saved });
      }
    }
  }

  return Array.from(map.values());
}

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
  /**
   * Catégories cochées dans le panneau POI : ce que la recherche corridor
   * interroge et conserve, indépendamment des filtres d'affichage de la
   * carte (`poisRouteEnabled`, `selectedPoiCategories`). Défaut :
   * `enabledCategories`.
   */
  searchCategories?: Set<PoiCategory>,
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
  const searchCategoriesRef = useRef(searchCategories ?? enabledCategories);
  searchCategoriesRef.current = searchCategories ?? enabledCategories;
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
  // Memoised on the array reference: O(n) only when the features change,
  // not on every render of the itinerary panel.
  const initialFeaturesKey = useMemo(() => (
    initialFeatures && initialFeatures.length > 0
      ? initialFeatures.map((feature) => [
        feature.id,
        feature.category,
        feature.favorite ? '1' : '0',
        feature.pauseDurationMin ?? 0,
        feature.lat,
        feature.lon,
      ].join(':')).join('|')
      : 'empty'
  ), [initialFeatures]);

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
      // Le serveur est interrogé avec r + tolérance de simplification :
      // les catégories sans distance X sont ramenées au rayon r.
      clampCorridorRadiusM(radiusRef.current),
    );

    return [...favorites, ...filteredNonFavorites];
  }, []);

  /**
   * Ce que la recherche enregistre dans l'itinéraire : tous les favoris +
   * les POI des catégories cochées dans leur distance X. Surtout pas le
   * sous-ensemble affiché, sinon masquer des POI sur la carte (vue
   * « Favoris » seule…) les effacerait du projet à la recherche suivante.
   */
  const buildStoredFeatures = useCallback((features: PoiFeature[]) => {
    const searched = searchCategoriesRef.current;
    const favorites = features.filter((feature) => feature.favorite);
    const others = features.filter((feature) => !feature.favorite && searched.has(feature.category));
    const route = gpxRef.current;
    if (!route || route.points.length < 2) return [...favorites, ...others];
    return [
      ...favorites,
      ...filterPoisByLateralDistance(
        others,
        route.points,
        maxLateralDistanceByCategoryRef.current ?? undefined,
        clampCorridorRadiusM(radiusRef.current),
      ),
    ];
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
    const cats = Array.from(searchCategoriesRef.current);
    if (!route || cats.length === 0) {
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

    // Polyligne simplifiée (tolérance <= r/4, sommets de virage conservés)
    // puis densifiée dans le budget de points du serveur, interrogée avec
    // r + tolérance ; le filtre latéral client ramène ensuite chaque
    // catégorie à sa distance X. Voir lib/corridor-samples.ts.
    // Le serveur rejette (400) tout rayon hors [1, 10000] m.
    const { samples, queryRadiusM } = buildCorridorSamples(route.points, radiusRef.current);

    try {
      const features = await fetchPoisAlongRouteChunked({
        samples,
        radiusM: queryRadiusM,
        categories: cats,
        signal: controller.signal,
        onProgress: (deduped, { done, total }) => {
          if (controller.signal.aborted) return;
          setCorridorProgress(total > 0 ? done / total : 0);
          // The empty "request started" tick must NOT wipe the rendered POIs
          // (it used to clear every marker and rebuild them all on response),
          // and the final tick is handled once by the completion branch below.
          if (deduped.length === 0 || done >= total) return;
          const all = mergeCorridorWithSavedFeatures(deduped, initialFeaturesRef.current);
          lastCorridorFeatures.current = all;
          syncRenderedFeatures(buildRenderableFeatures(all));
          onCorridorUpdateRef.current?.(buildStoredFeatures(all));
        },
      });
      if (!controller.signal.aborted) {
        const all = mergeCorridorWithSavedFeatures(features, initialFeaturesRef.current);
        lastCorridorFeatures.current = all;
        syncRenderedFeatures(buildRenderableFeatures(all));
        onCorridorCompleteRef.current?.(buildStoredFeatures(all));
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (controller.signal.aborted) return;
      // Échec : on ne touche NI aux POI enregistrés NI à la timeline NI à la
      // signature de recherche (onCorridorComplete n'est pas appelé) ; le
      // panneau affiche l'erreur et propose « Réessayer ».
      setError(describeCorridorError(err));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setCorridorProgress(null);
      }
    }
  }, [buildRenderableFeatures, buildStoredFeatures, syncRenderedFeatures]);

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

    const all = deduplicateFeatures(initialFeaturesRef.current);
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
    const all = deduplicateFeatures(initialFeaturesRef.current);
    lastCorridorFeatures.current = all;
    const seed = buildRenderableFeatures(all);
    syncRenderedFeatures(seed);
    setPoiCount(seed.length);
  }, [routeId, buildRenderableFeatures, syncRenderedFeatures]);

  // ── React to category / distance / filter changes ─────────────────

  useEffect(() => {
    if (!managerRef.current) return;
    // Un changement de réglage ne relance jamais la recherche d'elle-même
    // (chaque frappe dans une distance déclenchait une requête) : on
    // re-filtre l'existant, et le panneau propose « Relancer la recherche ».
    const source =
      lastCorridorFeatures.current.length > 0
        ? deduplicateFeatures(lastCorridorFeatures.current)
        : deduplicateFeatures(initialFeaturesRef.current);
    syncRenderedFeatures(buildRenderableFeatures(source));
  }, [
    map,
    isMapLoaded,
    enabledCategoriesKey,
    lateralDistanceKey,
    favorisEnabled,
    poisRouteEnabled,
    selectedPoiCategoriesKey,
    buildRenderableFeatures,
    syncRenderedFeatures,
  ]);

  // ── Rehydrate when the active itinerary's saved features change ───

  useEffect(() => {
    if (!managerRef.current) return;
    const currentCorridor = lastCorridorFeatures.current;
    const all = currentCorridor.length > 0
      ? mergeCorridorWithSavedFeatures(currentCorridor, initialFeaturesRef.current)
      : deduplicateFeatures(initialFeaturesRef.current);
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
