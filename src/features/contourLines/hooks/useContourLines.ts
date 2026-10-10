import { useEffect, useRef } from 'react';
import type { DataDrivenPropertyValueSpecification, Map as MapboxMap } from 'mapbox-gl';
import {
  buildContourCasingLayer,
  buildContourLineLayer,
  buildContourPaints,
  buildContourSource,
  CONTOUR_HD_MIN_MAP_ZOOM,
  CONTOUR_HD_SOURCE_ID,
  CONTOUR_LAYER_IDS,
  CONTOUR_LAYER_PREFIX,
  contourHdTileUrl,
  type ContourDemProfile,
  type ContourTone,
  type ContourVariant,
} from '../lib/contour-source';
import { subscribeServiceWorkerController } from '@/features/map3d/lib/serviceWorkerController';

const VARIANTS: readonly ContourVariant[] = ['mapbox', 'hd'];
/** Zoom maximal d'une couche Mapbox (style-spec). */
const MAX_LAYER_ZOOM = 24;

function findFirstSymbolLayerId(map: MapboxMap): string | undefined {
  return map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
}

function nativeContourLayerIds(map: MapboxMap): string[] {
  return (map.getStyle()?.layers ?? [])
    .filter((layer) => {
      const id = layer.id.toLowerCase();
      const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
      return !id.startsWith(CONTOUR_LAYER_PREFIX)
        && (sourceLayer === 'contour' || id.includes('contour'));
    })
    .map((layer) => layer.id);
}

function hideNativeContourLayers(map: MapboxMap) {
  for (const layerId of nativeContourLayerIds(map)) {
    try {
      map.setLayoutProperty(layerId, 'visibility', 'none');
    } catch {
      /* le style est peut-être encore en transition */
    }
  }
}

function addContourLayers(
  map: MapboxMap,
  opacity: number,
  intervalMeters: number,
  tone: ContourTone,
  demProfile: ContourDemProfile,
) {
  try {
    hideNativeContourLayers(map);
    const beforeId = findFirstSymbolLayerId(map);
    for (const variant of VARIANTS) {
      const ids = CONTOUR_LAYER_IDS[variant];
      if (!map.getSource(ids.source)) {
        map.addSource(ids.source, buildContourSource(variant, demProfile));
      }
      if (!map.getLayer(ids.casing)) {
        map.addLayer(
          buildContourCasingLayer(opacity, intervalMeters, tone, variant) as Parameters<MapboxMap['addLayer']>[0],
          beforeId,
        );
      }
      if (!map.getLayer(ids.line)) {
        map.addLayer(
          buildContourLineLayer(opacity, intervalMeters, tone, variant) as Parameters<MapboxMap['addLayer']>[0],
          beforeId,
        );
      }
    }
  } catch {
    /* le style est peut-être en transition */
  }
}

function removeContourLayers(map: MapboxMap) {
  try {
    for (const variant of VARIANTS) {
      const ids = CONTOUR_LAYER_IDS[variant];
      if (map.getLayer(ids.line)) map.removeLayer(ids.line);
      if (map.getLayer(ids.casing)) map.removeLayer(ids.casing);
      if (map.getSource(ids.source)) map.removeSource(ids.source);
    }
  } catch {
    /* le style est peut-être en transition */
  }
}

/**
 * Courbes de Mapbox sous CONTOUR_HD_MIN_MAP_ZOOM et courbes du SW au-dessus
 * quand le relief vient du pipeline HD ; celles de Mapbox seules sinon. Une
 * couche masquée ne demande aucune tuile : rien n'atteint /contour-tiles hors HD.
 */
function setContourVisibility(map: MapboxMap, visible: boolean, hd: boolean) {
  for (const variant of VARIANTS) {
    const ids = CONTOUR_LAYER_IDS[variant];
    const shown = visible && (variant === 'mapbox' || hd);
    for (const layerId of [ids.casing, ids.line]) {
      try {
        const layer = map.getLayer(layerId);
        if (!layer) continue;
        const maxzoom = hd ? CONTOUR_HD_MIN_MAP_ZOOM : MAX_LAYER_ZOOM;
        if (variant === 'mapbox' && (layer.maxzoom ?? MAX_LAYER_ZOOM) !== maxzoom) {
          map.setLayerZoomRange(layerId, 0, maxzoom);
        }
        const next = shown ? 'visible' : 'none';
        if (map.getLayoutProperty(layerId, 'visibility') !== next) {
          map.setLayoutProperty(layerId, 'visibility', next);
        }
      } catch {
        /* la couche n'existe peut-être pas encore */
      }
    }
  }
}

/** La source HD lit la tuile DEM du maillage : son URL suit le profil 1 m / 0,40 m. */
function updateContourDemProfile(map: MapboxMap, demProfile: ContourDemProfile) {
  try {
    const source = map.getSource(CONTOUR_HD_SOURCE_ID) as
      | { tiles?: string[]; setTiles?: (tiles: string[]) => unknown }
      | undefined;
    const url = contourHdTileUrl(demProfile);
    if (source?.setTiles && source.tiles?.[0] !== url) source.setTiles([url]);
  } catch {
    /* le style est peut-être en transition */
  }
}

function updateContourPaint(map: MapboxMap, opacity: number, intervalMeters: number, tone: ContourTone) {
  const paints = buildContourPaints(opacity, intervalMeters, tone);
  const casingOpacity = paints.casingOpacity as unknown as DataDrivenPropertyValueSpecification<number>;
  const casingWidth = paints.casingWidth as unknown as DataDrivenPropertyValueSpecification<number>;
  const lineOpacity = paints.lineOpacity as unknown as DataDrivenPropertyValueSpecification<number>;
  const lineWidth = paints.lineWidth as unknown as DataDrivenPropertyValueSpecification<number>;
  try {
    for (const variant of VARIANTS) {
      const ids = CONTOUR_LAYER_IDS[variant];
      if (map.getLayer(ids.casing)) {
        map.setFilter(ids.casing, paints.filter);
        map.setPaintProperty(ids.casing, 'line-color', paints.casingColor);
        map.setPaintProperty(ids.casing, 'line-opacity', casingOpacity);
        map.setPaintProperty(ids.casing, 'line-width', casingWidth);
      }
      if (map.getLayer(ids.line)) {
        map.setFilter(ids.line, paints.filter);
        map.setPaintProperty(ids.line, 'line-color', paints.lineColor);
        map.setPaintProperty(ids.line, 'line-opacity', lineOpacity);
        map.setPaintProperty(ids.line, 'line-width', lineWidth);
      }
    }
  } catch {
    /* le style est peut-être en transition */
  }
}

/**
 * @param hd vrai quand le relief 3D vient du pipeline HD du Service Worker
 *   (1 m / 0,40 m) : au-dessus du zoom 12, les courbes sont alors les isolignes
 *   de son maillage.
 * @param demProfile profil DEM de ce maillage (`terrain` = 1 m).
 */
export function useContourLines(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  intervalMeters: number,
  available: boolean,
  tone: ContourTone = 'light',
  hd = false,
  demProfile: ContourDemProfile = 'default',
) {
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const opacityRef = useRef(opacity);
  const intervalRef = useRef(intervalMeters);
  const availableRef = useRef(available);
  const toneRef = useRef(tone);
  const hdRef = useRef(hd);
  const demProfileRef = useRef(demProfile);

  useEffect(() => {
    enabledRef.current = enabled;
    opacityRef.current = opacity;
    intervalRef.current = intervalMeters;
    availableRef.current = available;
    toneRef.current = tone;
    hdRef.current = hd;
    demProfileRef.current = demProfile;
  }, [enabled, opacity, intervalMeters, available, tone, hd, demProfile]);

  useEffect(() => {
    if (!map || !isMapLoaded || !available) return;
    if (mountedRef.current) {
      hideNativeContourLayers(map);
      return;
    }
    addContourLayers(map, opacityRef.current, intervalRef.current, toneRef.current, demProfileRef.current);
    mountedRef.current = true;
    setContourVisibility(map, enabledRef.current && availableRef.current, hdRef.current);
  }, [map, isMapLoaded, available]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    updateContourDemProfile(map, demProfile);
  }, [map, isMapLoaded, demProfile]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    setContourVisibility(map, enabled && available, hd);
  }, [map, isMapLoaded, enabled, available, hd]);

  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    updateContourPaint(map, opacity, intervalMeters, tone);
  }, [map, isMapLoaded, opacity, intervalMeters, tone]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!availableRef.current) return;
        addContourLayers(map, opacityRef.current, intervalRef.current, toneRef.current, demProfileRef.current);
        mountedRef.current = true;
        setContourVisibility(map, enabledRef.current && availableRef.current, hdRef.current);
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => {
      map.off('style.load', onStyleLoad);
    };
  }, [map, isMapLoaded]);

  // Nouveau Service Worker aux commandes : les tuiles déjà demandées l'ont été
  // au précédent, ou au serveur quand celui-ci ne connaissait pas
  // /contour-tiles (204, que Mapbox garde comme tuile vide) : on les redemande.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    return subscribeServiceWorkerController(() => {
      try {
        (map.getSource(CONTOUR_HD_SOURCE_ID) as { reload?: () => void } | undefined)?.reload?.();
      } catch {
        /* le style est peut-être en transition */
      }
    });
  }, [map, isMapLoaded]);

  useEffect(() => {
    if (!map) return;
    return () => {
      try {
        if (map.getStyle && map.getStyle()) removeContourLayers(map);
      } catch {
        /* carte déjà détruite */
      }
      mountedRef.current = false;
    };
  }, [map]);
}
