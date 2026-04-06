import { useEffect, useRef, useCallback } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { TileCoord } from '../types';
import { wgs84ToTileCoord } from '../coordConvert';
import { useLidarManager } from './LidarContext';

/**
 * Adds a right-click context menu item "Charger LiDAR HD" on the Mapbox map.
 * When clicked, starts downloading the 1km² LiDAR tile at the cursor location.
 * Uses the shared LidarManager from LidarContext so progress/errors are visible in the panel.
 */
export function useLidarContextMenu(
  map: MapboxMap | null,
  onDownloadStart?: (coord: TileCoord) => void,
) {
  const manager = useLidarManager();
  const menuRef = useRef<HTMLDivElement | null>(null);

  const cleanup = useCallback(() => {
    if (menuRef.current) {
      menuRef.current.remove();
      menuRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!map) return;

    const handleContextMenu = (e: mapboxgl.MapMouseEvent) => {
      e.preventDefault();
      cleanup();

      const { lng, lat } = e.lngLat;
      const coord = wgs84ToTileCoord(lng, lat);

      // Create context menu
      const menu = document.createElement('div');
      Object.assign(menu.style, {
        position: 'fixed',
        left: `${e.originalEvent.clientX}px`,
        top: `${e.originalEvent.clientY}px`,
        zIndex: '1000',
        background: 'rgba(30, 30, 30, 0.95)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '8px',
        padding: '4px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        minWidth: '180px',
        fontFamily: 'system-ui, sans-serif',
      });

      const item = document.createElement('button');
      item.textContent = `🛰️ Charger LiDAR HD (${coord.xKm}_${coord.yKm})`;
      Object.assign(item.style, {
        display: 'block',
        width: '100%',
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        color: '#ddd',
        fontSize: '12px',
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: '6px',
      });

      item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,0.08)'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };

      item.onclick = () => {
        cleanup();
        onDownloadStart?.(coord);
        manager.downloadTile(coord);
      };

      menu.appendChild(item);
      document.body.appendChild(menu);
      menuRef.current = menu;

      // Close on any click elsewhere
      const closeHandler = () => {
        cleanup();
        document.removeEventListener('click', closeHandler);
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    };

    map.on('contextmenu', handleContextMenu);

    return () => {
      map.off('contextmenu', handleContextMenu);
      cleanup();
    };
  }, [map, manager, onDownloadStart, cleanup]);
}
