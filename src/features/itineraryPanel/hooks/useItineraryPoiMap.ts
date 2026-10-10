import { useMemo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { usePoi } from '@/features/poi/hooks/usePoi';
import type {
  GpxRoute,
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
 * Correspondance entre les clés de POI par ligne du panneau (taxonomie Figma) et
 * les catégories OSM sous-jacentes utilisées par le moteur de POI.
 *
 * Chaque ligne regroupe désormais toutes les catégories que la base indexe pour
 * ce besoin : une seule case fait apparaître toute la famille au lieu d'une
 * étiquette OSM étroite. Le moteur ne filtre plus rien d'autre (voir
 * `src/features/poi/lib/corridor-distance-filter.ts`) : une ligne cochée renvoie
 * vraiment *tous* les POI correspondants dans la distance de la ligne.
 */
const PANEL_TO_FEATURE_POI: Record<PanelPoiCategory, FeaturePoiCategory[]> = {
  fountains: ['drinking_water', 'water_point', 'water_tap', 'spring', 'fountain'],
  cemeteries: ['cemetery'],
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
  passes: ['pass'],
  health: ['pharmacy', 'hospital', 'clinic', 'doctors', 'defibrillator', 'police'],
  transport: ['train_station', 'bus_station', 'ferry_terminal', 'atm', 'post_office', 'laundry'],
};

const DEFAULT_RADIUS_M = 1000;
/** Anciennes clés gardées pour que les projets enregistrés avec l'ancienne bascule d'affinage se chargent encore. */
const POI_NON_ENTRY_KEYS = new Set(['refineResults', 'refineLimitPerKm']);

export interface UseItineraryPoiMapResult {
  loading: boolean;
  error: string | null;
  poiCount: number;
  /** Progression 0..1 de la recherche dans le couloir ; null au repos. */
  corridorProgress: number | null;
  /** Lance une recherche dans le couloir le long du tracé GPX de l'itinéraire actif. */
  searchCorridor: () => void;
  /** Interrompt la recherche dans le couloir en cours, s'il y en a une. */
  cancelSearchCorridor: () => void;
  hasGpxRoute: boolean;
  hasEnabledCategories: boolean;
  /** Rayon effectif (maximum des lignes activées) utilisé par la recherche dans le couloir. */
  radiusM: number;
  openPoiMarker: (
    poiId: number | string,
    category?: string,
    coords?: { lat: number; lon: number },
  ) => boolean;
}

/**
 * Relie l'éditeur de POI du panneau d'itinéraire du dock de gauche à la carte Mapbox :
 *
 * - Affiche la trace GPX de l'itinéraire actif comme une ligne stylée.
 * - Traduit les lignes de POI du panneau en catégories Overpass.
 * - Renvoie l'état de chargement / de comptage / d'erreur au panneau.
 *
 * Le hook n'a volontairement que des effets de bord sur la carte ; il ne
 * possède aucun état d'interface au-delà de ce que `usePoi` expose déjà.
 */
import { matchesPoiCategory } from '../sections/timeline/poiCategoryMatch';
import { isPanelPoiCategoryHidden } from '../lib/project/poiRows';

export function useItineraryPoiMap(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  active: Itinerary | null,
  onCorridorUpdate?: (features: PoiFeature[]) => void,
  onCorridorComplete?: (features: PoiFeature[], routePoints: GpxRoute['points']) => void,
  popupActions?: UsePoiPopupActions,
  poisRouteEnabled: boolean = true,
  favorisEnabled: boolean = true,
  selectedPoiCategories?: Set<string>,
): UseItineraryPoiMapResult {
  // ── Catégories OSM activées, dérivées des lignes de POI du panneau ──
  const enabledCategories = useMemo<Set<FeaturePoiCategory>>(() => {
    const set = new Set<FeaturePoiCategory>();
    if (!active?.poi || !poisRouteEnabled) return set;
    for (const [panelKey, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(panelKey) || isPanelPoiCategoryHidden(panelKey)) continue;
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

  // ── Catégories recherchées : les lignes cochées du panneau ─────────
  //
  // Indépendantes des filtres d'affichage de la carte (« POIs route »,
  // sélecteur de catégories) : masquer des POI à l'écran ne doit ni
  // empêcher la recherche ni restreindre ce qu'elle enregistre.
  const searchCategories = useMemo<Set<FeaturePoiCategory>>(() => {
    const set = new Set<FeaturePoiCategory>();
    if (!active?.poi) return set;
    for (const [panelKey, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(panelKey) || isPanelPoiCategoryHidden(panelKey)) continue;
      if (!raw || typeof raw !== 'object' || !(raw as PoiEntry).enabled) continue;
      for (const fk of PANEL_TO_FEATURE_POI[panelKey as PanelPoiCategory] ?? []) set.add(fk);
    }
    return set;
  }, [active]);

  // ── Rayon effectif du couloir : maximum des lignes activées ───────
  //
  // Le serveur de POI prend un seul rayon pour toute la requête du couloir : on
  // interroge donc avec le X le plus large demandé par une ligne activée, puis
  // on resserre chaque catégorie sur son propre X côté client
  // (`maxLateralDistanceByCategory` plus bas). Interroger avec le maximum — au
  // lieu d'une valeur fixe par défaut — est ce qui rend « tous les POI dans X »
  // vraiment exact pour la ligne la plus large.
  const radiusM = useMemo(() => {
    if (!active?.poi) return DEFAULT_RADIUS_M;
    let max = 0;
    for (const [k, raw] of Object.entries(active.poi)) {
      if (POI_NON_ENTRY_KEYS.has(k) || isPanelPoiCategoryHidden(k)) continue;
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
      if (POI_NON_ENTRY_KEYS.has(panelKey) || isPanelPoiCategoryHidden(panelKey)) continue;
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

  // ── Toggle « Affiner les résultats » : la carte n'affiche que les POI
  // retenus par le tri auto, comme la feuille de route. Clé sur les ids :
  // l'itinéraire est cloné à chaque édition, la référence de `picks` aussi.
  const autoSortPicks = active?.poiAutoSortEnabled ? active.poiAutoSort?.picks : undefined;
  const refinedPoiIdsKey = useMemo(
    () => (autoSortPicks ? autoSortPicks.map((pick) => pick.id).join(',') : null),
    [autoSortPicks],
  );
  const refinedPoiIds = useMemo<ReadonlySet<number> | null>(
    () => (refinedPoiIdsKey == null
      ? null
      : new Set(refinedPoiIdsKey ? refinedPoiIdsKey.split(',').map(Number) : [])),
    [refinedPoiIdsKey],
  );

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
    searchCategories,
    refinedPoiIds,
  );

  return {
    loading,
    error,
    poiCount,
    corridorProgress,
    searchCorridor,
    cancelSearchCorridor,
    hasGpxRoute: gpxRoute !== null,
    hasEnabledCategories: searchCategories.size > 0,
    radiusM,
    openPoiMarker,
  };
}
