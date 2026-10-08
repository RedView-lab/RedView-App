import { useEffect, useRef } from 'react';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { type GeoJSONSource, type LngLat, type Map as MapboxMap, type MapMouseEvent, type Point } from 'mapbox-gl';
import type { TileCoord } from '../types';
import { sameTileCoord, tileCoordToWgs84Polygon, tileFootprintSuffix, wgs84ToTileCoord } from '../lib/coordConvert';
import { fileTileCoordAt, loadFileTileIndex, resolveFileTileCoord } from '../lib/fileTiles';
import { useLidarManager } from './useLidarManager';
import { lidarCoverageJapanZoneAt, removeLidarCoverageLayers, syncLidarCoverageLayers } from './lidarCoverageLayers';

const SOURCE_ID = 'lidar-selection-source';
const HOVER_FILL_ID = 'lidar-selection-hover-fill';
const HOVER_LINE_ID = 'lidar-selection-hover-line';
const SELECTED_FILL_ID = 'lidar-selection-selected-fill';
const SELECTED_LINE_ID = 'lidar-selection-selected-line';
const LAYER_ORDER = [HOVER_FILL_ID, SELECTED_FILL_ID, HOVER_LINE_ID, SELECTED_LINE_ID] as const;

interface StyleHealth {
  hasStyle: boolean;
  isStyleLoaded: boolean;
  sourceCount: number;
  layerCount: number;
}

function canInspectStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

function readStyleHealth(map: MapboxMap): StyleHealth {
  try {
    const style = map.getStyle();
    return {
      hasStyle: Boolean(style),
      isStyleLoaded: map.isStyleLoaded(),
      sourceCount: Object.keys(style?.sources ?? {}).length,
      layerCount: Array.isArray(style?.layers) ? style.layers.length : 0,
    };
  } catch {
    return {
      hasStyle: false,
      isStyleLoaded: false,
      sourceCount: 0,
      layerCount: 0,
    };
  }
}

type SelectionFeature = Feature<Polygon, { role: 'hover' | 'selected'; tileId: string }>;

function createFeature(coord: TileCoord, role: 'hover' | 'selected'): SelectionFeature {
  return {
    type: 'Feature',
    properties: {
      role,
      tileId: `${coord.xKm}_${coord.yKm}_${coord.projection}${tileFootprintSuffix(coord)}`,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [tileCoordToWgs84Polygon(coord)],
    },
  };
}

function buildFeatureCollection(
  hovered: TileCoord | null,
  selected: TileCoord | null,
  enabled: boolean,
): FeatureCollection<Polygon, { role: 'hover' | 'selected'; tileId: string }> {
  const features: SelectionFeature[] = [];

  if (selected) {
    features.push(createFeature(selected, 'selected'));
  }

  if (enabled && hovered && !sameTileCoord(hovered, selected)) {
    features.push(createFeature(hovered, 'hover'));
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

type SelectionLayer = Parameters<MapboxMap['addLayer']>[0];

const SELECTION_LAYERS: Record<(typeof LAYER_ORDER)[number], SelectionLayer> = {
  [HOVER_FILL_ID]: {
    id: HOVER_FILL_ID,
    type: 'fill',
    source: SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'hover'],
    paint: {
      'fill-color': '#ff453a',
      'fill-opacity': 0.08,
      'fill-emissive-strength': 1,
    },
  },
  [SELECTED_FILL_ID]: {
    id: SELECTED_FILL_ID,
    type: 'fill',
    source: SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'selected'],
    paint: {
      'fill-color': '#ff3b30',
      'fill-opacity': 0.14,
      'fill-emissive-strength': 1,
    },
  },
  [HOVER_LINE_ID]: {
    id: HOVER_LINE_ID,
    type: 'line',
    source: SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'hover'],
    paint: {
      'line-color': '#ff453a',
      'line-opacity': 0.95,
      'line-width': 2,
      'line-dasharray': [2, 2],
      'line-emissive-strength': 1,
      'line-occlusion-opacity': 1,
    },
  },
  [SELECTED_LINE_ID]: {
    id: SELECTED_LINE_ID,
    type: 'line',
    source: SOURCE_ID,
    slot: 'top',
    filter: ['==', ['get', 'role'], 'selected'],
    paint: {
      'line-color': '#ff3b30',
      'line-opacity': 1,
      'line-width': 2.5,
      'line-emissive-strength': 1,
      'line-occlusion-opacity': 1,
    },
  },
};

/** Première couche de sélection présente dans le style : les couches de couverture passent dessous. */
function firstSelectionLayerId(map: MapboxMap): string | undefined {
  try {
    return LAYER_ORDER.find((layerId) => map.getLayer(layerId));
  } catch {
    return undefined;
  }
}

/**
 * Ajoute les couches de sélection manquantes, chacune juste sous la couche de
 * sélection suivante déjà présente : la pile reste toujours LAYER_ORDER sans
 * rien déplacer. Appelé à chaque `styledata` : ne doit pas toucher au style
 * quand rien ne manque. (Avant, chaque appel faisait `moveLayer` sur les quatre
 * couches ; Mapbox marque le style modifié même pour un déplacement nul, donc
 * chaque `styledata` produisait le suivant — une mise à jour du style à chaque
 * image, sans fin : cache de drapage du terrain vidé à chaque image, placement
 * complet des libellés, carte jamais au repos.)
 */
function ensureSelectionLayers(map: MapboxMap): boolean {
  if (!canInspectStyle(map)) return false;

  // Chaque section est isolée : un échec n'empêche pas les autres.
  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [],
        },
      });
    }
  } catch {
    return false;
  }

  LAYER_ORDER.forEach((layerId, index) => {
    try {
      if (map.getLayer(layerId)) return;
      const beforeId = LAYER_ORDER.slice(index + 1).find((nextId) => map.getLayer(nextId));
      map.addLayer(SELECTION_LAYERS[layerId], beforeId);
    } catch { /* skip */ }
  });

  // La source peut ne pas être interrogeable juste après addSource pendant une
  // reconstruction du graphe de style — ne signaler le succès que si on la retrouve.
  return Boolean(map.getSource(SOURCE_ID));
}

function removeSelectionLayers(map: MapboxMap): void {
  if (!canInspectStyle(map)) return;
  removeLidarCoverageLayers(map);

  try {
    for (const layerId of [SELECTED_LINE_ID, SELECTED_FILL_ID, HOVER_LINE_ID, HOVER_FILL_ID]) {
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
    }

    if (map.getSource(SOURCE_ID)) {
      map.removeSource(SOURCE_ID);
    }
  } catch {
    /* la carte est peut-être en cours de destruction */
  }
}

export function useLidarSelection(
  map: MapboxMap | null,
  enabled: boolean,
  onDisable?: () => void,
) {
  const manager = useLidarManager();
  const enabledRef = useRef(enabled);
  const hoveredRef = useRef<TileCoord | null>(null);
  const selectedRef = useRef<TileCoord | null>(null);
  const onDisableRef = useRef(onDisable);
  const syncFrameRef = useRef<number | null>(null);
  const syncTimeoutRef = useRef<number | null>(null);
  const styleFallbackUsableRef = useRef(false);
  /** Resynchronise la couche via l'instance courante de l'effet (sélection résolue après coup). */
  const syncOverlayRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    onDisableRef.current = onDisable;
  }, [onDisable]);

  useEffect(() => {
    if (!map) return;

    styleFallbackUsableRef.current = false;

    let canvas: ReturnType<MapboxMap['getCanvas']> | null = null;
    try {
      canvas = map.getCanvas();
    } catch {
      canvas = null;
    }

    const canMutateOverlayStyle = (): boolean => {
      const health = readStyleHealth(map);
      if (!health.hasStyle) return false;
      if (health.isStyleLoaded) return true;
      if (!styleFallbackUsableRef.current) return false;
      return health.sourceCount > 0 || health.layerCount > 0;
    };

    const promoteStyleFallbackIfUsable = (): boolean => {
      if (styleFallbackUsableRef.current) return true;
      const health = readStyleHealth(map);
      if (!health.hasStyle) return false;
      if (health.sourceCount === 0 && health.layerCount === 0) return false;
      styleFallbackUsableRef.current = true;
      return true;
    };

    // Dernière sélection poussée, et vers quelle instance de source (un
    // rechargement du style la recrée vide) : une synchro qui ne change rien ne
    // pousse rien — chaque `setData` est un re-parse dans le worker et une mise à jour de la source.
    let pushedSource: GeoJSONSource | null = null;
    let pushedKey = '';

    // Renvoie true quand les données ont été poussées, false quand le graphe
    // de style n'était pas prêt (l'appelant peut programmer un nouvel essai).
    const updateSourceData = (): boolean => {
      if (!canMutateOverlayStyle() && !promoteStyleFallbackIfUsable()) return false;

      // Couverture LiDAR dense (France, Suisse, Japon, NZ) sous les couches de sélection.
      syncLidarCoverageLayers(map, enabledRef.current, firstSelectionLayerId(map));
      const ready = ensureSelectionLayers(map);
      if (!ready) return false;

      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return false;

      const data = buildFeatureCollection(hoveredRef.current, selectedRef.current, enabledRef.current);
      const key = data.features.map((feature) => `${feature.properties.role}:${feature.properties.tileId}`).join('|');
      if (source === pushedSource && key === pushedKey) return true;
      source.setData(data);
      pushedSource = source;
      pushedKey = key;
      return true;
    };

    const clearScheduledSync = () => {
      if (syncFrameRef.current !== null) {
        window.cancelAnimationFrame(syncFrameRef.current);
        syncFrameRef.current = null;
      }
      if (syncTimeoutRef.current !== null) {
        window.clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }
    };

    const scheduleOverlaySync = () => {
      clearScheduledSync();
      if (updateSourceData()) return;  // voie rapide — style déjà prêt
      syncFrameRef.current = window.requestAnimationFrame(() => {
        syncFrameRef.current = null;
        if (updateSourceData()) return;
        // Style toujours pas prêt — en cascade : nouvel essai à 150 ms puis 500 ms.
        syncTimeoutRef.current = window.setTimeout(() => {
          syncTimeoutRef.current = null;
          if (updateSourceData()) return;
          syncTimeoutRef.current = window.setTimeout(() => {
            syncTimeoutRef.current = null;
            updateSourceData();
          }, 400);
        }, 150);
      });
    };

    syncOverlayRef.current = scheduleOverlaySync;
    let disposed = false;

    const clearSelectionForTile = (coord: TileCoord | null | undefined) => {
      if (!coord) return;

      const hoveredMatches = sameTileCoord(coord, hoveredRef.current);
      const selectedMatches = sameTileCoord(coord, selectedRef.current);

      if (!hoveredMatches && !selectedMatches) return;

      if (hoveredMatches) {
        hoveredRef.current = null;
      }
      if (selectedMatches) {
        selectedRef.current = null;
      }

      if (!updateSourceData()) {
        scheduleOverlaySync();
      }
    };

    const unsubscribeManager = manager.on((event) => {
      if (event.type === 'tileLoaded' || event.type === 'cancelled' || event.type === 'error') {
        clearSelectionForTile(event.tileCoord);
      }
    });

    // Dalle de 1 km sous le point ; la zone JGD2011 est celle des données LiDAR affichées.
    const kmTileCoordAt = (lngLat: LngLat, point: Point): TileCoord =>
      wgs84ToTileCoord(lngLat.lng, lngLat.lat, { japanZone: lidarCoverageJapanZoneAt(map, point) });

    const setHovered = (coord: TileCoord | null) => {
      if (coord === hoveredRef.current || sameTileCoord(coord, hoveredRef.current)) return;
      hoveredRef.current = coord;
      if (!updateSourceData()) {
        scheduleOverlaySync();
      }
    };

    let pointer: { lngLat: LngLat; point: Point } | null = null;

    // Au Japon, en NZ, aux Pays-Bas et en Flandre, la dalle survolée est le
    // fichier réel sous le curseur (emprise de l'index), pas un carré de 1 km.
    const refreshHover = () => {
      if (disposed || !enabledRef.current || !pointer) return;
      const coord = kmTileCoordAt(pointer.lngLat, pointer.point);
      const fileCoord = fileTileCoordAt(coord, pointer.lngLat.lng, pointer.lngLat.lat);
      if (fileCoord) {
        setHovered(fileCoord);
        return;
      }
      // Index du pays en cours de chargement : pas de contour plutôt qu'un carré trompeur.
      setHovered(null);
      void loadFileTileIndex(coord, pointer.lngLat.lng, pointer.lngLat.lat).then(refreshHover);
    };

    const handleMouseMove = (event: MapMouseEvent) => {
      if (!enabledRef.current) return;
      pointer = { lngLat: event.lngLat, point: event.point };
      refreshHover();
    };

    const selectTile = (coord: TileCoord) => {
      selectedRef.current = coord;
      syncOverlayRef.current?.();
      void manager.downloadTile(coord);
    };

    const handleClick = (event: MapMouseEvent) => {
      if (!enabledRef.current) return;

      const hovered = hoveredRef.current;
      hoveredRef.current = null;
      if (hovered) {
        selectTile(hovered);
      } else {
        const { lng, lat } = event.lngLat;
        void resolveFileTileCoord(kmTileCoordAt(event.lngLat, event.point), lng, lat).then(selectTile);
      }
      onDisableRef.current?.();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        hoveredRef.current = null;
        if (!updateSourceData()) {
          scheduleOverlaySync();
        }
        onDisableRef.current?.();
      }
    };

    const handleMouseLeave = () => {
      pointer = null;
      hoveredRef.current = null;
      if (!updateSourceData()) {
        scheduleOverlaySync();
      }
    };

    const handleStyleLoad = () => {
      scheduleOverlaySync();
    };

    const handleStyleData = () => {
      scheduleOverlaySync();
    };

    // Index des dalles-fichiers (Japon, NZ, Pays-Bas, Flandre) chargé dès que la vue arrive sur le pays.
    const preloadFileTileIndex = () => {
      if (!enabledRef.current) return;
      try {
        const center = map.getCenter();
        void loadFileTileIndex(wgs84ToTileCoord(center.lng, center.lat), center.lng, center.lat);
      } catch {
        /* la carte est peut-être en cours de destruction */
      }
    };

    // La couverture d'un pays n'est chargée qu'une fois la vue arrivée dessus.
    const handleMoveEnd = () => {
      if (!enabledRef.current) return;
      scheduleOverlaySync();
      preloadFileTileIndex();
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      if (!enabledRef.current) return;
      event.preventDefault();
      hoveredRef.current = null;
      if (!updateSourceData()) {
        scheduleOverlaySync();
      }
      onDisableRef.current?.();
    };

    map.on('mousemove', handleMouseMove);
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);
    map.on('style.load', handleStyleLoad);
    map.on('styledata', handleStyleData);
    map.on('moveend', handleMoveEnd);
    canvas?.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('keydown', handleKeyDown);

    if (enabled) {
      if (canvas) canvas.style.cursor = 'crosshair';
      scheduleOverlaySync();
      preloadFileTileIndex();
    } else {
      hoveredRef.current = null;
      if (canvas) canvas.style.cursor = '';
      scheduleOverlaySync();
    }

    return () => {
      disposed = true;
      if (syncOverlayRef.current === scheduleOverlaySync) syncOverlayRef.current = null;
      unsubscribeManager();
      clearScheduledSync();
      map.off('mousemove', handleMouseMove);
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
      map.off('style.load', handleStyleLoad);
      map.off('styledata', handleStyleData);
      map.off('moveend', handleMoveEnd);
      canvas?.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('keydown', handleKeyDown);
      if (canvas) canvas.style.cursor = '';
      removeSelectionLayers(map);
    };
  }, [map, manager, enabled]);
}
