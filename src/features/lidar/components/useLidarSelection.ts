import { useEffect, useRef } from 'react';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { type GeoJSONSource, type Map as MapboxMap, type MapMouseEvent } from 'mapbox-gl';
import type { TileCoord } from '../types';
import { tileCoordToWgs84Polygon, wgs84ToTileCoord } from '../coordConvert';
import { useLidarManager } from './LidarContext';

const SOURCE_ID = 'lidar-selection-source';
const HOVER_FILL_ID = 'lidar-selection-hover-fill';
const HOVER_LINE_ID = 'lidar-selection-hover-line';
const SELECTED_FILL_ID = 'lidar-selection-selected-fill';
const SELECTED_LINE_ID = 'lidar-selection-selected-line';
const LAYER_ORDER = [HOVER_FILL_ID, SELECTED_FILL_ID, HOVER_LINE_ID, SELECTED_LINE_ID] as const;

type SelectionFeature = Feature<Polygon, { role: 'hover' | 'selected'; tileId: string }>;

function sameTile(a: TileCoord | null, b: TileCoord | null): boolean {
  if (!a || !b) return false;
  return a.xKm === b.xKm && a.yKm === b.yKm && a.projection === b.projection;
}

function createFeature(coord: TileCoord, role: 'hover' | 'selected'): SelectionFeature {
  return {
    type: 'Feature',
    properties: {
      role,
      tileId: `${coord.xKm}_${coord.yKm}_${coord.projection}`,
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

  if (enabled && hovered && !sameTile(hovered, selected)) {
    features.push(createFeature(hovered, 'hover'));
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function restackSelectionLayers(map: MapboxMap): void {
  for (const layerId of LAYER_ORDER) {
    if (!map.getLayer(layerId)) continue;
    try {
      map.moveLayer(layerId);
    } catch {
      // Mapbox can reject a move while the style graph is still settling.
    }
  }
}

function ensureSelectionLayers(map: MapboxMap): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
  }

  if (!map.getLayer(HOVER_FILL_ID)) {
    map.addLayer({
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
    });
  }

  if (!map.getLayer(HOVER_LINE_ID)) {
    map.addLayer({
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
    });
  }

  if (!map.getLayer(SELECTED_FILL_ID)) {
    map.addLayer({
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
    });
  }

  if (!map.getLayer(SELECTED_LINE_ID)) {
    map.addLayer({
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
    });
  }

  restackSelectionLayers(map);
}

function removeSelectionLayers(map: MapboxMap): void {
  for (const layerId of [SELECTED_LINE_ID, SELECTED_FILL_ID, HOVER_LINE_ID, HOVER_FILL_ID]) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  }

  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
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

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    onDisableRef.current = onDisable;
  }, [onDisable]);

  useEffect(() => {
    if (!map) return;

    const updateSourceData = () => {
      if (!map.isStyleLoaded()) return;

      ensureSelectionLayers(map);

      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;

      source.setData(buildFeatureCollection(hoveredRef.current, selectedRef.current, enabledRef.current));
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
      updateSourceData();
      syncFrameRef.current = window.requestAnimationFrame(() => {
        syncFrameRef.current = null;
        updateSourceData();
      });
      syncTimeoutRef.current = window.setTimeout(() => {
        syncTimeoutRef.current = null;
        updateSourceData();
      }, 150);
    };

    const handleMouseMove = (event: MapMouseEvent) => {
      if (!enabledRef.current) return;

      const nextCoord = wgs84ToTileCoord(event.lngLat.lng, event.lngLat.lat);
      if (sameTile(nextCoord, hoveredRef.current)) return;

      hoveredRef.current = nextCoord;
      updateSourceData();
    };

    const handleClick = (event: MapMouseEvent) => {
      if (!enabledRef.current) return;

      const coord = hoveredRef.current ?? wgs84ToTileCoord(event.lngLat.lng, event.lngLat.lat);
      selectedRef.current = coord;
      updateSourceData();
      void manager.downloadTile(coord);
    };

    const handleMouseLeave = () => {
      hoveredRef.current = null;
      updateSourceData();
    };

    const handleStyleLoad = () => {
      scheduleOverlaySync();
    };

    const handleStyleData = () => {
      scheduleOverlaySync();
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      if (!enabledRef.current) return;
      event.preventDefault();
      hoveredRef.current = null;
      updateSourceData();
      onDisableRef.current?.();
    };

    map.on('mousemove', handleMouseMove);
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);
    map.on('style.load', handleStyleLoad);
    map.on('styledata', handleStyleData);
    map.getCanvas().addEventListener('mouseleave', handleMouseLeave);

    if (enabled) {
      map.getCanvas().style.cursor = 'crosshair';
      scheduleOverlaySync();
    } else {
      hoveredRef.current = null;
      map.getCanvas().style.cursor = '';
      scheduleOverlaySync();
    }

    return () => {
      clearScheduledSync();
      map.off('mousemove', handleMouseMove);
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
      map.off('style.load', handleStyleLoad);
      map.off('styledata', handleStyleData);
      map.getCanvas().removeEventListener('mouseleave', handleMouseLeave);
      map.getCanvas().style.cursor = '';
      removeSelectionLayers(map);
    };
  }, [map, manager, enabled]);
}
