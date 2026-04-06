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
      filter: ['==', ['get', 'role'], 'hover'],
      paint: {
        'fill-color': '#ff453a',
        'fill-opacity': 0.08,
      },
    });
  }

  if (!map.getLayer(HOVER_LINE_ID)) {
    map.addLayer({
      id: HOVER_LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'role'], 'hover'],
      paint: {
        'line-color': '#ff453a',
        'line-opacity': 0.95,
        'line-width': 2,
        'line-dasharray': [2, 2],
      },
    });
  }

  if (!map.getLayer(SELECTED_FILL_ID)) {
    map.addLayer({
      id: SELECTED_FILL_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['==', ['get', 'role'], 'selected'],
      paint: {
        'fill-color': '#ff3b30',
        'fill-opacity': 0.14,
      },
    });
  }

  if (!map.getLayer(SELECTED_LINE_ID)) {
    map.addLayer({
      id: SELECTED_LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'role'], 'selected'],
      paint: {
        'line-color': '#ff3b30',
        'line-opacity': 1,
        'line-width': 2.5,
      },
    });
  }
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

export function useLidarSelection(map: MapboxMap | null, enabled: boolean) {
  const manager = useLidarManager();
  const enabledRef = useRef(enabled);
  const hoveredRef = useRef<TileCoord | null>(null);
  const selectedRef = useRef<TileCoord | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!map) return;

    const updateSourceData = () => {
      if (!map.isStyleLoaded()) return;

      ensureSelectionLayers(map);

      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;

      source.setData(buildFeatureCollection(hoveredRef.current, selectedRef.current, enabledRef.current));
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
      updateSourceData();
    };

    map.on('mousemove', handleMouseMove);
    map.on('click', handleClick);
    map.on('style.load', handleStyleLoad);
    map.getCanvas().addEventListener('mouseleave', handleMouseLeave);

    if (enabled) {
      map.getCanvas().style.cursor = 'crosshair';
      updateSourceData();
    } else {
      hoveredRef.current = null;
      map.getCanvas().style.cursor = '';
      updateSourceData();
    }

    return () => {
      map.off('mousemove', handleMouseMove);
      map.off('click', handleClick);
      map.off('style.load', handleStyleLoad);
      map.getCanvas().removeEventListener('mouseleave', handleMouseLeave);
      map.getCanvas().style.cursor = '';
      removeSelectionLayers(map);
    };
  }, [map, manager, enabled]);
}
