import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { AltitudeCategory, AltitudeColorMode } from '../types';
import {
  ALTITUDE_LAYER_ID,
  ALTITUDE_SOURCE_ID,
  type AltitudeTileSourceOptions,
  altitudeUsesServiceWorker,
  buildAltitudeColorExpression,
  buildAltitudeLayer,
  buildAltitudeSource,
  buildAltitudeSourceKey,
} from '../lib/altitude-source';
import type { OverlayStatusReporter } from '@/features/map3d';
import { useAltitudeLoadStatus } from './useAltitudeLoadStatus';

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearAltitudeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_ALTITUDE_CACHE' });
    console.log('[altitude][debug] CLEAR_ALTITUDE_CACHE sent — reload to fetch fresh tiles.');
  };
}

const DEFAULT_SOURCE_OPTIONS: AltitudeTileSourceOptions = { zone: null };

function postToServiceWorker(message: Record<string, unknown>): void {
  try {
    navigator.serviceWorker?.controller?.postMessage(message);
  } catch {
    /* le Service Worker ne contrôle peut-être pas encore cette page */
  }
}

interface AltitudeLayerProps {
  opacity: number;
  colorMode: AltitudeColorMode;
  categories: AltitudeCategory[];
  hiddenIds: ReadonlySet<string>;
  sourceOptions: AltitudeTileSourceOptions;
}

function removeAltitudeLayer(map: MapboxMap): void {
  try {
    if (map.getLayer(ALTITUDE_LAYER_ID)) map.removeLayer(ALTITUDE_LAYER_ID);
    if (map.getSource(ALTITUDE_SOURCE_ID)) map.removeSource(ALTITUDE_SOURCE_ID);
  } catch {
    /* le style est peut-être en transition, ou la carte déjà détruite */
  }
}

function setAltitudeVisibility(map: MapboxMap, visible: boolean): void {
  try {
    if (map.getLayer(ALTITUDE_LAYER_ID)) {
      map.setLayoutProperty(ALTITUDE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    }
  } catch {
    /* le style est peut-être en transition */
  }
}

/**
 * Idempotent : fait exister la source + la couche d'altitude pour `sourceKey`
 * et les rend visibles. Remplace la source quand la clé a changé (qualité 3D /
 * profil DEM / zone). Renvoie false quand le style n'est pas encore prêt —
 * l'appelant réessaie.
 */
function ensureAltitudeLayer(
  map: MapboxMap,
  sourceKey: string,
  mountedKeyRef: { current: string | null },
  props: AltitudeLayerProps,
): boolean {
  try {
    const hasLayer = Boolean(map.getLayer(ALTITUDE_LAYER_ID));
    if (hasLayer && mountedKeyRef.current === sourceKey) {
      setAltitudeVisibility(map, true);
      return true;
    }
    if (hasLayer || map.getSource(ALTITUDE_SOURCE_ID)) removeAltitudeLayer(map);
    mountedKeyRef.current = null;

    map.addSource(
      ALTITUDE_SOURCE_ID,
      buildAltitudeSource(props.sourceOptions) as Parameters<MapboxMap['addSource']>[1],
    );
    const layer = buildAltitudeLayer(
      props.opacity,
      props.colorMode,
      props.categories,
      props.hiddenIds,
    );
    map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);
    mountedKeyRef.current = sourceKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Surcouche d'altitude (teinte hypsométrique).
 *
 * La surcouche ne télécharge jamais l'altitude elle-même : ses tuiles sont les
 * tuiles DEM que le terrain 3D a déjà décodées (`AltitudeDemSource`), colorées
 * sur le GPU (`raster-color`). La désactivation masque seulement la couche —
 * une réactivation repeint depuis les tuiles que la source garde encore.
 */
export function useAltitude(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenBandIds?: ReadonlyArray<string>,
  sourceOptions: AltitudeTileSourceOptions = DEFAULT_SOURCE_OPTIONS,
  onLoadStatusChange?: OverlayStatusReporter,
) {
  const hiddenIds = useMemo(() => new Set(hiddenBandIds ?? []), [hiddenBandIds]);
  const sourceKey = buildAltitudeSourceKey(sourceOptions);
  const usesServiceWorker = altitudeUsesServiceWorker(sourceOptions);

  // Dernières propriétés de peinture / de source, lues quand on (re)construit
  // la couche, pour que l'effet de montage ne se relance pas à chaque cran de
  // curseur. Effet de layout : synchronisé avant que les effets passifs
  // ci-dessous les lisent.
  const propsRef = useRef<AltitudeLayerProps>({ opacity, colorMode, categories, hiddenIds, sourceOptions });
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    propsRef.current = { opacity, colorMode, categories, hiddenIds, sourceOptions };
    enabledRef.current = enabled;
  });
  const mountedKeyRef = useRef<string | null>(null);

  // ── Montage / remplacement / visibilité / rechargement du style ───────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!enabled) {
      setAltitudeVisibility(map, false);
      return;
    }

    let cancelled = false;
    let deferTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled || !enabledRef.current) return;
      if (ensureAltitudeLayer(map, sourceKey, mountedKeyRef, propsRef.current)) {
        map.triggerRepaint();
        return;
      }
      // Style pas prêt : un seul nouvel essai au prochain événement de style —
      // jamais un écouteur `sourcedata` permanent (il se déclenche à chaque
      // tuile pendant les chargements).
      map.once('styledata', attempt);
    };

    // Un changement de fond de carte efface toutes les couches personnalisées ;
    // on les réajoute une fois le nouveau style posé (tick suivant, pour que
    // les couches de base arrivent d'abord et que l'ordre des slots tienne).
    const onStyleLoad = () => {
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

  // ── Pression sur le Service Worker (chemin masqué par zone seulement) ──
  // La source à DEM partagé lit les tuiles du terrain et ne sollicite jamais le SW.
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled || !usesServiceWorker) return;
    postToServiceWorker({ type: 'ALTITUDE_ACTIVE_STATE', active: true });
    return () => {
      postToServiceWorker({ type: 'ALTITUDE_ACTIVE_STATE', active: false });
      postToServiceWorker({ type: 'CANCEL_ALTITUDE_WORK' });
    };
  }, [map, isMapLoaded, enabled, usesServiceWorker]);

  // ── Paint ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    try {
      if (map.getLayer(ALTITUDE_LAYER_ID)) {
        map.setPaintProperty(ALTITUDE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* le style est peut-être en transition */
    }
  }, [map, isMapLoaded, opacity]);

  useEffect(() => {
    if (!map || !isMapLoaded || !categories.length) return;
    try {
      if (map.getLayer(ALTITUDE_LAYER_ID)) {
        const expr = buildAltitudeColorExpression(categories, colorMode, hiddenIds);
        map.setPaintProperty(ALTITUDE_LAYER_ID, 'raster-color', expr as unknown as string);
      }
    } catch {
      /* le style est peut-être en transition */
    }
  }, [map, isMapLoaded, colorMode, categories, hiddenIds]);

  // ── Teardown ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    return () => {
      removeAltitudeLayer(map);
      mountedKeyRef.current = null;
    };
  }, [map]);

  useAltitudeLoadStatus(map, isMapLoaded, enabled, sourceKey, onLoadStatusChange);
}
