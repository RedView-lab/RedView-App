import { useState, useEffect, useCallback, useRef } from 'react';
import { LidarManager } from '../lidarManager';
import type { TileCoord, CachedTileInfo, DownloadProgress } from '../types';
import { toWgs84 } from '../coordConvert';

export function useLidar() {
  const managerRef = useRef<LidarManager | null>(null);
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [storageUsed, setStorageUsed] = useState(0);
  const [storageQuota, setStorageQuota] = useState(0);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mgr = new LidarManager();
    managerRef.current = mgr;

    const unsub = mgr.on((event) => {
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
    return () => { unsub(); mgr.destroy(); };
  }, []);

  const refreshCache = useCallback(async () => {
    const mgr = managerRef.current;
    if (!mgr) return;
    const tiles = await mgr.getCachedTiles();
    setCachedTiles(tiles);
    const usage = await mgr.getStorageUsage();
    setStorageUsed(usage.used);
    setStorageQuota(usage.quota);
  }, []);

  const downloadTile = useCallback(async (coord: TileCoord) => {
    setError(null);
    await managerRef.current?.downloadTile(coord);
  }, []);

  const removeTile = useCallback(async (coord: TileCoord) => {
    await managerRef.current?.removeTile(coord);
    refreshCache();
  }, [refreshCache]);

  const openViewer = useCallback((coord: TileCoord) => {
    managerRef.current?.openViewer(coord);
  }, []);

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
