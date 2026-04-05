import { useCallback } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { TileCoord } from '../types/geometry';
import { useLidarPicking } from '../hooks/useLidarPicking';
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
    window.open(
      `/lidar-viewer.html?${params.toString()}`,
      `lidar_${coord.xKm}_${coord.yKm}`,
      'width=1200,height=800',
    );
  }, []);

  const picking = useLidarPicking(map);

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
