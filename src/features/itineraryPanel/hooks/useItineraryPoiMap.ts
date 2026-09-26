import { useMemo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { usePoi } from '@/features/poi/hooks/usePoi';
import type {
  PoiCategory as FeaturePoiCategory,
  PoiFeature,
} from '@/features/poi/types';
import type { UsePoiPopupActions } from '@/features/poi/hooks/usePoi';

import type {
  Itinerary,
  PoiCategory as PanelPoiCategory,
  PoiEntry,
} from '../types';

/**
 * Mapping from the panel's per-row POI keys (Figma taxonomy) to the
 * underlying OSM categories used by the POI engine.
 *
 * Each row now aggregates every category the base indexes for that need, so
 * a single checkbox surfaces the whole family instead of one narrow OSM tag.
 * The engine no longer filters anything else out (see
 * `src/features/poi/lib/corridor-distance-filter.ts`), which means a checked
 * row really does return *all* matching POI within the row's distance.
 */
const PANEL_TO_FEATURE_POI: Record<PanelPoiCategory, FeaturePoiCategory[]> = {
  fountains: ['drinking_water', 'water_point', 'water_tap', 'spring', 'fountain'],
  toilets: ['toilets', 'shower'],
  supermarkets: ['supermarket', 'convenience', 'marketplace'],
  gasStations: ['fuel', 'charging_station'],
  bakeries: ['bakery', 'butcher', 'ice_cream'],
  fastFood: ['fast_food', 'vending_machine'],
  cafes: ['cafe'],
  bars: ['bar', 'pub'],
  restaurants: ['restaurant'],
  bikeShops: ['bicycle', 'bicycle_repair', 'compressed_air', 'outdoor_shop'],
  hotels: ['hotel', 'camp_site', 'caravan_site'],
  refuges: ['alpine_hut', 'wilderness_hut', 'shelter'],
  passes: ['pass', 'viewpoint', 'picnic_site'],
  health: ['pharmacy', 'hospital', 'clinic', 'doctors', 'defibrillator', 'police'],
  transport: ['train_station', 'bus_station', 'ferry_terminal', 'atm', 'post_office', 'laundry'],
};

const DEFAULT_RADIUS_M = 1000;
/** Legacy keys kept so projects saved with the removed refine toggle still load. */
const POI_NON_ENTRY_KEYS = new Set(['refineResults', 'refineLimitPerKm']);

export interface UseItineraryPoiMapResult {
  loading: boolean;
  error: string | null;
  poiCount: number;
  /** 0..1 corridor-search progress; null while idle. */
  corridorProgress: number | null;
  /** Trigger a corridor search along the active itinerary's GPX route. */
  searchCorridor: () => void;
  /** Abort the in-flight corridor search, if any. */
  cancelSearchCorridor: () => void;
  hasGpxRoute: boolean;
  hasEnabledCategories: boolean;
  /** Effective radius (max of enabled rows) used by the corridor search. */
  radiusM: number;
  openPoiMarker: (
    poiId: number | string,
    category?: string,
    coords?: { lat: number; lon: number },
  ) => boolean;
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
import { matchesPoiCategory } from '../sections/timeline/poiCategoryMatch';

export function useItineraryPoiMap(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  active: Itinerary | null,
  onCorridorUpdate?: (features: PoiFeature[]) => void,
  onCorridorComplete?: (features: PoiFeature[]) => void,
  popupActions?: UsePoiPopupActions,
  poisRouteEnabled: boolean = true,
  favorisEnabled: boolean = true,
  selectedPoiCategories?: Set<string>,
): UseItineraryPoiMapResult {
  // ── Derive enabled OSM categories from the panel POI rows ─────────
  const enabledCategories = useMemo<Set<FeaturePoiCategory>>(() => {
    const set = new Set<FeaturePoiCategory>();
    if (!active?.poi || !poisRouteEnabled) return set;
    for (const [panelKey, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(panelKey)) continue;
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as PoiEntry;
      if (!entry.enabled) continue;
      if (
        selectedPoiCategories &&
        selectedPoiCategories.size > 0 &&
        !matchesPoiCategory(panelKey as PanelPoiCategory, selectedPoiCategories)
      ) {
        continue;
      }
      const mapped = PANEL_TO_FEATURE_POI[panelKey as PanelPoiCategory] ?? [];
      for (const fk of mapped) set.add(fk);
    }
    return set;
  }, [active, poisRouteEnabled, selectedPoiCategories]);

  // ── Effective corridor radius: max of enabled rows ────────────────
  //
  // The POI server takes a single radius for the whole corridor query, so
  // we query with the widest X any enabled row asks for, then narrow each
  // category down to its own X on the client
  // (`maxLateralDistanceByCategory` below). Querying with the max — instead
  // of a fixed default — is what makes "all POIs within X" actually true
  // for the widest row.
  const radiusM = useMemo(() => {
    if (!active?.poi) return DEFAULT_RADIUS_M;
    let max = 0;
    for (const [k, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(k)) continue;
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as PoiEntry;
      if (entry.enabled && typeof entry.distanceM === 'number' && entry.distanceM > max) {
        max = entry.distanceM;
      }
    }
    return max > 0 ? max : DEFAULT_RADIUS_M;
  }, [active]);

  const maxLateralDistanceByCategory = useMemo<Partial<Record<FeaturePoiCategory, number>> | null>(() => {
    if (!active?.poi) return null;
    const next: Partial<Record<FeaturePoiCategory, number>> = {};
    for (const [panelKey, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(panelKey)) continue;
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as PoiEntry;
      if (!entry.enabled || typeof entry.distanceM !== 'number' || entry.distanceM <= 0) continue;
      const mapped = PANEL_TO_FEATURE_POI[panelKey as PanelPoiCategory] ?? [];
      for (const category of mapped) {
        next[category] = entry.distanceM;
      }
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [active]);

  const gpxRoute = active?.gpxRoute ?? null;
  const persistedPoiFeatures = active?.poiFeatures ?? null;

  const {
    loading,
    error,
    poiCount,
    corridorProgress,
    searchCorridor,
    cancelSearchCorridor,
    openPoiMarker,
  } = usePoi(
    map,
    isMapLoaded,
    enabledCategories,
    gpxRoute,
    radiusM,
    maxLateralDistanceByCategory,
    onCorridorUpdate,
    onCorridorComplete,
    persistedPoiFeatures,
    popupActions,
    active?.id ?? null,
    poisRouteEnabled,
    favorisEnabled,
    selectedPoiCategories,
  );

  return {
    loading,
    error,
    poiCount,
    corridorProgress,
    searchCorridor,
    cancelSearchCorridor,
    hasGpxRoute: gpxRoute !== null,
    hasEnabledCategories: enabledCategories.size > 0,
    radiusM,
    openPoiMarker,
  };
}
