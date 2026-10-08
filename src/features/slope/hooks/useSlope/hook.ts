import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { SlopeCategory, SlopeColorMode, SlopeDemProfile } from '../../types';
import {
  SLOPE_LAYER_ID,
  type SlopeTileSourceOptions,
  type SlopeZoneOptions,
  buildSlopeColorExpression,
  buildSlopeSourceKey,
} from '../../lib/slope-source';
import {
  addSlopeLayer,
  hiddenIdsFromRanges,
  notifySlopeActiveState,
  removeSlopeLayer,
  setSlopeVisibility,
} from './helpers';
import { useSlopeProgressReporter } from './progress';

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearSlopeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
    console.log('[slope][debug] CLEAR_SLOPE_CACHE sent — reload to fetch fresh tiles.');
  };
}

const DEFAULT_SOURCE_OPTIONS: SlopeTileSourceOptions = { demProfile: 'default', resolutionFactor: 1 };

interface SlopeLayerProps {
  opacity: number;
  colorMode: SlopeColorMode;
  categories: SlopeCategory[];
  hiddenIds: Set<string>;
  sourceOptions: SlopeTileSourceOptions;
}

type ZonePipelineStamp = { hash: string; profile: string; time: number } | null;

function startZonePipeline(
  zone: SlopeZoneOptions,
  profile: SlopeDemProfile,
  lastRef: { current: ZonePipelineStamp },
): void {
  const now = Date.now();
  const last = lastRef.current;
  if (last && last.hash === zone.hash && last.profile === profile && now - last.time < 1000) return;
  lastRef.current = { hash: zone.hash, profile, time: now };

  try {
    const [w, s, e, n] = zone.bounds;
    const tiles: Array<{ z: number; x: number; y: number }> = [];
    const z = 14;
    const world = 1 << z;
    const minX = Math.max(0, Math.min(world - 1, Math.floor(((w + 180) / 360) * world)));
    const maxX = Math.max(0, Math.min(world - 1, Math.floor(((e + 180) / 360) * world)));
    const minLatRad = (Math.min(85, Math.max(-85, s)) * Math.PI) / 180;
    const maxLatRad = (Math.min(85, Math.max(-85, n)) * Math.PI) / 180;
    const maxY = Math.max(0, Math.min(world - 1, Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + minLatRad / 2)) / (2 * Math.PI)) * world)));
    const minY = Math.max(0, Math.min(world - 1, Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + maxLatRad / 2)) / (2 * Math.PI)) * world)));

    for (let tx = minX; tx <= maxX; tx++) {
      for (let ty = minY; ty <= maxY; ty++) {
        tiles.push({ z, x: tx, y: ty });
      }
    }
    navigator.serviceWorker?.controller?.postMessage({
      type: 'START_ZONE_SLOPE_PIPELINE',
      profile,
      zone: zone.hash,
      ring: zone.ring,
      tiles,
    });
  } catch {
    /* au mieux */
  }
}

/**
 * Idempotent : fait exister la source + la couche de pente pour `sourceKey` et
 * les rend visibles, en remplaçant la source quand la clé a changé (profil DEM
 * / résolution / zone). Renvoie null quand le style n'est pas prêt (l'appelant
 * réessaie), sinon si un remplacement / un nouvel ajout a eu lieu.
 */
function ensureSlopeLayer(
  map: MapboxMap,
  sourceKey: string,
  mountedKeyRef: { current: string | null },
  props: SlopeLayerProps,
): { added: boolean } | null {
  try {
    const hasLayer = Boolean(map.getLayer(SLOPE_LAYER_ID));
    if (hasLayer && mountedKeyRef.current === sourceKey) {
      setSlopeVisibility(map, true);
      return { added: false };
    }
    removeSlopeLayer(map);
    mountedKeyRef.current = null;
    const ok = addSlopeLayer(
      map,
      props.opacity,
      props.colorMode,
      props.categories,
      props.hiddenIds,
      props.sourceOptions,
    );
    if (!ok) return null;
    mountedKeyRef.current = sourceKey;
    setSlopeVisibility(map, true);
    return { added: true };
  } catch {
    return null;
  }
}

/**
 * Surcouche de pente. La désactivation masque seulement la couche (source
 * gardée, pour que le graphe du terrain 3D reste stable et qu'une réactivation
 * repeigne depuis le cache).
 */
export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: ReadonlyArray<readonly [number, number]>,
  categories?: SlopeCategory[],
  sourceOptions: SlopeTileSourceOptions = DEFAULT_SOURCE_OPTIONS,
  onLoadStatusChange?: Parameters<typeof useSlopeProgressReporter>[0]['onLoadStatusChange'],
) {
  const hiddenIds = useMemo(
    () => hiddenIdsFromRanges(hiddenRanges, categories),
    [hiddenRanges, categories],
  );
  const categoriesKey = useMemo(
    () => (categories ?? []).map((category) => `${category.id}:${category.minDeg}-${category.maxDeg}:${category.color}`).join('|'),
    [categories],
  );
  const hiddenKey = useMemo(() => Array.from(hiddenIds).sort().join(','), [hiddenIds]);

  // Les tuiles demandées avant que le Service Worker contrôle la page sont
  // allées au repli serveur : pente 30 m, ou un 204 / 429 que Mapbox marque en
  // erreur et ne redemande jamais (source.reload() saute les tuiles en erreur).
  // Un nouveau contrôleur change la clé de la source pour que chaque tuile soit
  // redemandée via le SW.
  const [swControllerEpoch, setSwControllerEpoch] = useState(0);
  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onControllerChange = () => setSwControllerEpoch((n) => n + 1);
    sw.addEventListener('controllerchange', onControllerChange);
    return () => sw.removeEventListener('controllerchange', onControllerChange);
  }, []);

  const sourceKey = useMemo(
    () => `${buildSlopeSourceKey(sourceOptions)}#sw${swControllerEpoch}`,
    [sourceOptions, swControllerEpoch],
  );

  // Effet de layout : synchronisé avant que les effets passifs ci-dessous les lisent.
  const propsRef = useRef<SlopeLayerProps>({
    opacity, colorMode, categories: categories ?? [], hiddenIds, sourceOptions,
  });
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    propsRef.current = { opacity, colorMode, categories: categories ?? [], hiddenIds, sourceOptions };
    enabledRef.current = enabled;
  });

  const mountedRef = useRef(false);
  const mountedKeyRef = useRef<string | null>(null);
  const lastZonePipelineRef = useRef<ZonePipelineStamp>(null);

  // ── Montage / remplacement / visibilité / rechargement du style ───────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!enabled) {
      setSlopeVisibility(map, false);
      return;
    }

    let cancelled = false;
    let deferTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled || !enabledRef.current) return;
      const hadMountedKey = mountedKeyRef.current;
      const result = ensureSlopeLayer(map, sourceKey, mountedKeyRef, propsRef.current);
      if (!result) {
        mountedRef.current = false;
        // Style pas prêt : un seul nouvel essai, jamais un écouteur permanent par tuile.
        map.once('styledata', attempt);
        return;
      }
      mountedRef.current = true;
      if (result.added) {
        map.triggerRepaint();
        // Changement de résolution / de profil sur une zone → relance la récupération multiple de la zone.
        const { zone, demProfile } = propsRef.current.sourceOptions;
        if (hadMountedKey && zone?.bounds) startZonePipeline(zone, demProfile, lastZonePipelineRef);
      }
    };

    // Un changement de fond de carte efface les couches personnalisées ; on les
    // réajoute au tick suivant pour que les couches de base arrivent d'abord et
    // que l'ordre des slots tienne.
    const onStyleLoad = () => {
      mountedRef.current = false;
      mountedKeyRef.current = null;
      if (deferTimer) clearTimeout(deferTimer);
      deferTimer = setTimeout(attempt, 0);
    };

    attempt();
    map.on('style.load', onStyleLoad);
    return () => {
      cancelled = true;
      if (deferTimer) clearTimeout(deferTimer);
      map.off('styledata', attempt);
      map.off('style.load', onStyleLoad);
    };
  }, [map, isMapLoaded, enabled, sourceKey]);

  // ── Notification de l'état actif ──────────────────────────────────
  // Demande au SW d'agrandir le niveau chaud du DEM quand la pente est active
  // (elle lit ~5× plus de tuiles DEM que le fond de carte), et relance le
  // pipeline de zone.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    notifySlopeActiveState(enabled);
    if (!enabled) return;
    const { zone, demProfile } = propsRef.current.sourceOptions;
    if (zone?.bounds) startZonePipeline(zone, demProfile, lastZonePipelineRef);
  }, [map, isMapLoaded, enabled]);

  // ── Paint ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* le style est peut-être en transition */
    }
  }, [map, isMapLoaded, opacity]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const { categories: cats, colorMode: mode, hiddenIds: hidden } = propsRef.current;
    if (!cats.length) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        const expression = buildSlopeColorExpression(cats, mode, hidden);
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-color', expression as unknown as string);
      }
    } catch {
      /* le style est peut-être en transition */
    }
  }, [map, isMapLoaded, colorMode, categoriesKey, hiddenKey]);

  // ── Teardown ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    return () => {
      removeSlopeLayer(map);
      mountedRef.current = false;
      mountedKeyRef.current = null;
    };
  }, [map]);

  useSlopeProgressReporter({
    map,
    isMapLoaded,
    enabled,
    onLoadStatusChange,
    mountedRef,
  });
}
