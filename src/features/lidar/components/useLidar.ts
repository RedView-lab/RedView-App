import { useState, useEffect, useCallback } from 'react';
import type { TileCoord, CachedTileInfo, DownloadProgress } from '../types';
import { toWgs84 } from '../coordConvert';
import { useLidarManager } from './LidarContext';

export function useLidar() {
  const manager = useLidarManager();
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [storageUsed, setStorageUsed] = useState(0);
  const [storageQuota, setStorageQuota] = useState(0);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = manager.on((event) => {
      if (event.type === 'progress' && event.progress) {
        setProgress(event.progress);
        setError(null);
      }
      if (event.type === 'tileLoaded' || event.type === 'tileRemoved') {
        setProgress(null);
        refreshCache();
      }
      if (event.type === 'error') {
        setProgress(null);
        setError(event.message ?? 'Erreur inconnue');
      }
    });

    refreshCache();
    return unsub;
  }, [manager]);

  const refreshCache = useCallback(async () => {
    const tiles = await manager.getCachedTiles();
    setCachedTiles(tiles);
    const usage = await manager.getStorageUsage();
    setStorageUsed(usage.used);
    setStorageQuota(usage.quota);
  }, [manager]);

  const downloadTile = useCallback(async (coord: TileCoord) => {
    setError(null);
    await manager.downloadTile(coord);
  }, [manager]);

  const removeTile = useCallback(async (coord: TileCoord) => {
    await manager.removeTile(coord);
    refreshCache();
  }, [manager, refreshCache]);

  const openViewer = useCallback((coord: TileCoord) => {
    manager.openViewer(coord);
  }, [manager]);

  const getTileCenter = useCallback((coord: TileCoord): [number, number] => {
    return toWgs84(
      coord.xKm * 1000 + 500,
      coord.yKm * 1000 + 500,
      coord.projection,
    );
  }, []);

  return {
    cachedTiles,
    storageUsed,
    storageQuota,
    progress,
    error,
    downloadTile,
    removeTile,
    openViewer,
    getTileCenter,
  };
}
