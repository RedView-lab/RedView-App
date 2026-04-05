import { useEffect, useRef, useCallback } from 'react';
import type { Map as MapboxMap, GeoJSONSource } from 'mapbox-gl';
import type { TileCoord } from '../types/geometry';
import { viewportToTileCoords, tileToGeoJsonFeature } from '../tile-manager/tile-grid';
import { tileCoordKey } from '../processing/coord-transform';
import { listCachedTiles } from '../storage/tile-store';

const SOURCE_ID = 'lidar-tile-grid';
const FILL_LAYER = 'lidar-grid-fill';
const LINE_LAYER = 'lidar-grid-line';

export function useTileGrid(
  map: MapboxMap | null,
  onTileClick: (coord: TileCoord) => void,
) {
  const cachedKeys = useRef(new Set<string>());

  const refreshGrid = useCallback(() => {
    if (!map) return;

    // Re-scan OPFS for cached tiles before rendering
    listCachedTiles().then((cached) => {
      cachedKeys.current.clear();
      for (const t of cached) {
        cachedKeys.current.add(tileCoordKey(t.coord));
      }

      const bounds = map.getBounds()!;
      const zoom = map.getZoom();
      if (zoom < 12) {
        const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
        if (source) {
          source.setData({ type: 'FeatureCollection', features: [] });
        }
        return;
      }

      const tiles = viewportToTileCoords(
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      );

      const features = tiles.map((coord) => {
        const key = tileCoordKey(coord);
        const status = cachedKeys.current.has(key) ? 'cached' : 'available';
        return tileToGeoJsonFeature(coord, status);
      });

      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData({ type: 'FeatureCollection', features });
      }
    }).catch(() => {});
  }, [map]);

  useEffect(() => {
    if (!map) return;

    listCachedTiles().then((cached) => {
      for (const t of cached) {
        cachedKeys.current.add(tileCoordKey(t.coord));
      }
    });

    const onStyleLoad = () => {
      // Clean up orphaned layers/source from previous style loads
      if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
      if (map.getLayer(FILL_LAYER)) map.removeLayer(FILL_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: FILL_LAYER,
        type: 'fill',
        source: SOURCE_ID,
        slot: 'top',
        paint: {
          'fill-color': [
            'match', ['get', 'status'],
            'cached', 'rgba(0,200,100,0.15)',
            'downloading', 'rgba(255,200,0,0.2)',
            'error', 'rgba(255,50,50,0.15)',
            'rgba(100,150,255,0.1)',
          ],
          'fill-outline-color': [
            'match', ['get', 'status'],
            'cached', 'rgba(0,200,100,0.6)',
            'downloading', 'rgba(255,200,0,0.6)',
            'rgba(100,150,255,0.4)',
          ],
        },
      });

      map.addLayer({
        id: LINE_LAYER,
        type: 'line',
        source: SOURCE_ID,
        slot: 'top',
        paint: {
          'line-color': [
            'match', ['get', 'status'],
            'cached', '#00c864',
            'downloading', '#ffc800',
            '#6496ff',
          ],
          'line-width': 1,
        },
      });

      map.on('click', FILL_LAYER, (e) => {
        const feature = e.features?.[0];
        if (!feature || !feature.properties) return;
        const { xKm, yKm, territory } = feature.properties;
        const coord: TileCoord = {
          xKm: Number(xKm),
          yKm: Number(yKm),
          territory: territory as TileCoord['territory'],
          projection: 'LAMB93',
          altRef: 'IGN69',
        };
        onTileClick(coord);
      });

      map.on('mouseenter', FILL_LAYER, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', FILL_LAYER, () => {
        map.getCanvas().style.cursor = '';
      });
    };

    map.on('style.load', onStyleLoad);
    if (map.isStyleLoaded()) {
      onStyleLoad();
      refreshGrid();
    } else {
      map.once('load', () => { onStyleLoad(); refreshGrid(); });
    }

    map.on('moveend', refreshGrid);

    return () => {
      map.off('moveend', refreshGrid);
      map.off('style.load', onStyleLoad);
      if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
      if (map.getLayer(FILL_LAYER)) map.removeLayer(FILL_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map, onTileClick, refreshGrid]);

  return { refreshGrid };
}
