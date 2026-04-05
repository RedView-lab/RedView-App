import { useCallback } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { TileCoord } from '../types/geometry';
import { useTileGrid } from '../hooks/useTileGrid';

export function TileGridLayer({ map }: { map: MapboxMap | null }) {
  const openViewer = useCallback((coord: TileCoord) => {
    const params = new URLSearchParams({
      x: String(coord.xKm),
      y: String(coord.yKm),
      t: coord.territory,
    });
    window.open(
      `/lidar-viewer.html?${params.toString()}`,
      `lidar_${coord.xKm}_${coord.yKm}`,
      'width=1200,height=800',
    );
  }, []);

  useTileGrid(map, openViewer);

  return null;
}
