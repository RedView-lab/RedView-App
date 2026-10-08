// Hook du moteur de POI — récupère les POI le long du corridor GPX actif et
// les affiche sur la carte 3D Mapbox.
//
// Le rendu est délégué à `PoiMarkerManager` (lib/poi-markers.ts) : une seule
// couche symbol GPU avec des sprites prérastérisés, placement / masquage par
// collision explicitement désactivés, et sa propre réinstallation au
// rechargement du style. Ce hook ne lui fournit que la liste filtrée.
//
// Politique de filtrage — EXHAUSTIVE PAR CONCEPTION :
//   Le seul filtre appliqué est celui que règle l'utilisateur : pour chaque
//   catégorie, on garde chaque POI dont la distance latérale à la trace est
//   <= les X mètres réglés dans le panneau POI. Il n'y a volontairement PLUS de
//   plafond de densité, PLUS de présélection « N meilleurs par km », PLUS
//   d'exclusion par horaires d'ouverture ni de masquage selon le zoom — la
//   carte doit montrer *tous* les POI qui existent dans la distance demandée.
//   Voir lib/corridor-distance-filter.ts.
//   Exception, sur option : `refinedPoiIds` (bouton « Affiner les résultats »)
//   restreint l'affichage aux POI retenus par le tri automatique.

import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { PoiCategory, PoiFeature, GpxRoute } from '../types';
import { GPX_IMPORT_POI_SOURCE } from '../types';
import { PoiApiError, clampCorridorRadiusM, fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { buildCorridorSamples } from '../lib/corridor-samples';
import { filterPoisByLateralDistance } from '../lib/corridor-distance-filter';
import { PoiMarkerManager } from '../lib/poi-markers';
import type { UsePoiPopupActions } from '../lib/poi-popup';
import { matchesPoiCategory } from '@/features/itineraryPanel/sections/timeline/poiCategoryMatch';
import { buildRouteGeometrySignature } from '@/features/itineraryPanel/lib/routes';
import '../styles/floating-markers.css';

// Réexporté pour que les consommateurs existants continuent d'importer depuis le module du hook.
export type {  UsePoiPopupActions } from '../lib/poi-popup';

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

/** ~2 m : un POI importé d'un GPX et son original OSM ont les mêmes coordonnées (6 décimales). */
const IMPORTED_POI_MATCH_DEG = 2e-5;

/**
 * POI importé d'un GPX (id local négatif) que la recherche vient de retrouver
 * dans la base : même position et même nom (ou POI OSM sans nom).
 */
function findFreshTwinOfImportedPoi(saved: PoiFeature, freshFeatures: PoiFeature[]): PoiFeature | null {
  if (saved.tags?.source !== GPX_IMPORT_POI_SOURCE) return null;
  const savedName = saved.name?.trim() || null;
  for (const fresh of freshFeatures) {
    if (Math.abs(fresh.lat - saved.lat) > IMPORTED_POI_MATCH_DEG) continue;
    if (Math.abs(fresh.lon - saved.lon) > IMPORTED_POI_MATCH_DEG) continue;
    const freshName = fresh.name?.trim() || null;
    if (freshName === null || freshName === savedName) return fresh;
  }
  return null;
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
      // Favori importé d'un GPX retrouvé par la recherche : on reporte le favori
      // sur le POI de la base au lieu d'afficher deux marqueurs superposés.
      const twin = saved.favorite ? findFreshTwinOfImportedPoi(saved, freshFeatures) : null;
      const twinEntry = twin ? map.get(twin.id) : undefined;
      if (twinEntry && !twinEntry.favorite) {
        twinEntry.favorite = true;
        twinEntry.pauseDurationMin = saved.pauseDurationMin ?? twinEntry.pauseDurationMin ?? null;
        if (saved.favoriteSource) twinEntry.favoriteSource = saved.favoriteSource;
        continue;
      }

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
  /** Fin de recherche : POI à enregistrer et trace sur laquelle ils ont été cherchés. */
  onCorridorComplete?: (features: PoiFeature[], routePoints: GpxRoute['points']) => void,
  /**
   * Objets POI préchargés à afficher tout de suite (p. ex. réhydratés depuis un
   * projet enregistré). Amorce le registre des marqueurs pour qu'un changement
   * d'itinéraire restaure les marqueurs sans relancer la recherche en corridor.
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
  /**
   * Toggle « Affiner les résultats » : seuls ces POI (plus les favoris et les
   * POI marqués d'une pause) sont affichés. null = pas de filtre. Affichage
   * seulement : la recherche enregistre toujours tous les POI. Doit rester
   * stable tant que son contenu ne change pas (dépendance d'effet).
   */
  refinedPoiIds: ReadonlySet<number> | null = null,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poiCount, setPoiCount] = useState(0);
  /** Progression 0..1 des requêtes en corridor ; null quand rien ne tourne. */
  const [corridorProgress, setCorridorProgress] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const managerRef = useRef<PoiMarkerManager | null>(null);
  const lastCorridorFeatures = useRef<PoiFeature[]>([]);

  // Recopie les entrées réactives dans des réfs pour que les callbacks stables lisent des valeurs fraîches.
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
  const refinedPoiIdsRef = useRef(refinedPoiIds);
  refinedPoiIdsRef.current = refinedPoiIds;
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

  // Clés de dépendance stables pour les effets qui réagissent aux changements de sens.
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
  // Identité des objets enregistrés de l'itinéraire : un changement signale un
  // changement d'itinéraire ou un favori basculé, et déclenche une
  // réhydratation des marqueurs. Mémoïsé sur la référence du tableau : O(n)
  // seulement quand les objets changent, pas à chaque rendu du panneau
  // d'itinéraire.
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

  // ── Filtrage des objets ───────────────────────────────────────────
  //
  // Deux passes seulement, toutes deux réglées par l'utilisateur :
  //   1. la catégorie est activée dans le panneau POI / la barre de filtres,
  //   2. la distance latérale à la trace est <= les X mètres réglés pour
  //      cette catégorie.
  // Les favoris ne sont affichés QUE si `favorisEnabled` est vrai (et que la catégorie correspond).
  // Les autres ne sont affichés QUE si `poisRouteEnabled` est vrai (et que la catégorie correspond),
  // et, avec « Affiner les résultats » activé, seulement s'ils sont retenus par le tri automatique ou en pause.

  const buildRenderableFeatures = useCallback((features: PoiFeature[]) => {
    if (features.length === 0) return [];

    const matchesCategory = (category: PoiCategory) => {
      const activeCats = selectedPoiCategoriesRef.current;
      if (!activeCats || activeCats.size === 0) return true;
      return matchesPoiCategory(category, activeCats);
    };

    const isFavEnabled = favorisEnabledRef.current;
    const isRoutePoisEnabled = poisRouteEnabledRef.current;
    const refined = refinedPoiIdsRef.current;
    const keptByRefine = (feature: PoiFeature) =>
      !refined || refined.has(feature.id) || (feature.pauseDurationMin ?? 0) > 0;

    const favorites = isFavEnabled
      ? features.filter((feature) => feature.favorite && matchesCategory(feature.category))
      : [];
    const nonFavorites = isRoutePoisEnabled
      ? features.filter(
          (feature) =>
            !feature.favorite &&
            enabledRef.current.has(feature.category) &&
            matchesCategory(feature.category) &&
            keptByRefine(feature),
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

  // ── Requête en corridor (le long de la trace GPX, par morceaux et progressive) ──

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
          // Le tick vide « requête démarrée » ne doit PAS effacer les POI
          // affichés (il vidait tous les marqueurs et les reconstruisait tous à
          // la réponse), et le tick final est traité une fois par la branche de
          // fin ci-dessous.
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
        onCorridorCompleteRef.current?.(buildStoredFeatures(all), route.points);
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

  // ── Déclencheurs publics ──────────────────────────────────────────

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

  // ── Cycle de vie du gestionnaire de marqueurs ─────────────────────

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

  // ── Cycle de vie au changement de trace ───────────────────────────

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

  // ── Réaction aux changements de catégorie / distance / filtre ─────

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
    refinedPoiIds,
    buildRenderableFeatures,
    syncRenderedFeatures,
  ]);

  // ── Trace déplacée : le dernier corridor appartient à l'ancienne trace ──
  //
  // Sans ça, la réhydratation ci-dessous le refusionnerait avec les POI
  // enregistrés et l'ancien corridor resterait affiché.
  const routeGeometryKey = useMemo(
    () => buildRouteGeometrySignature(gpxRoute?.points),
    [gpxRoute?.points],
  );
  useEffect(() => {
    lastCorridorFeatures.current = [];
  }, [routeGeometryKey]);

  // ── Réhydratation quand les objets enregistrés de l'itinéraire actif changent ──

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
