import { useCallback, useEffect } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { TileCoord } from '../types/geometry';
import { useLidarPicking } from '../hooks/useLidarPicking';
import { useTileGrid } from '../hooks/useTileGrid';
import { LidarPanel } from './LidarPanel';
import { PickingBanner } from './PickingBanner';
import { ConfirmPopup } from './ConfirmPopup';

export function TileGridLayer({ map }: { map: MapboxMap | null }) {
  const openViewer = useCallback((coord: TileCoord) => {
    const params = new URLSearchParams({
      x: String(coord.xKm),
      y: String(coord.yKm),
      t: coord.territory,
    });
    window.open(`/lidar-viewer.html?${params.toString()}`, '_blank');
  }, []);

  const picking = useLidarPicking(map);
  const { refreshGrid } = useTileGrid(map, openViewer);

  // Refresh the grid overlay whenever cached tiles change (after download/delete)
  useEffect(() => {
    refreshGrid();
  }, [picking.cachedTiles, refreshGrid]);

  return (
    <>
      <LidarPanel
        picking={picking}
        onView={openViewer}
      />
      <PickingBanner active={picking.isPicking} />
      <ConfirmPopup
        coord={picking.pendingCoord}
        screenPos={picking.clickScreenPos}
        onConfirm={picking.confirmDownload}
        onCancel={picking.cancelPending}
      />
    </>
  );
}
