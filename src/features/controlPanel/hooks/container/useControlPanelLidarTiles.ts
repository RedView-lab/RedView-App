import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLidarManager } from '@/features/lidar/components/LidarContext';
import type { CachedTileInfo, DownloadProgress, TileCoord } from '@/features/lidar/types';
import { loadLidarTileLabels, setLidarTileLabel, syncLidarRouteOverlay } from '@/features/lidar';
import type { Itinerary } from '@/features/itineraryPanel/types';
import type { ControlPanelPersistedState } from '../../lib/persistedState';

function formatLidarTileLabel(info: CachedTileInfo): string {
  const sizeMb = Math.round(info.sizeBytes / (1024 * 1024));
  const year = new Date(info.cachedAt).getFullYear();
  return `Tuile ${info.coord.xKm}×${info.coord.yKm} (LIDAR) (${sizeMb}mo) (${year} IGN)`;
}

function tileKey(coord: TileCoord): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}`;
}

interface UseControlPanelLidarTilesArgs {
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  onToggleLidarDownloadMode?: () => void;
  itineraries?: readonly Itinerary[];
}

/**
 * Gère l'état des dalles LiDAR téléchargées, le renommage, la suppression
 * et la progression du téléchargement.
 */
export function useControlPanelLidarTiles({
  initialControlPanel,
  updateProjectControlPanel,
  onToggleLidarDownloadMode,
  itineraries,
}: UseControlPanelLidarTilesArgs) {
  const lidarManager = useLidarManager();
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [hiddenTiles, setHiddenTiles] = useState<Record<string, boolean>>(
    () => initialControlPanel.lidarTilesHidden ?? {},
  );
  const [customLabels, setCustomLabels] = useState<Record<string, string>>(
    () => loadLidarTileLabels(),
  );
  const [lidarDownloadProgress, setLidarDownloadProgress] = useState<DownloadProgress | null>(null);
  const [lidarDownloadError, setLidarDownloadError] = useState<string | null>(null);

  const refreshTiles = useCallback(async () => {
    try {
      setCachedTiles(await lidarManager.getCachedTiles());
    } catch (err) {
      console.warn('[controlPanel] getCachedTiles failed', err);
    }
  }, [lidarManager]);

  useEffect(() => {
    void refreshTiles();
    return lidarManager.on((evt) => {
      if (evt.type === 'progress' && evt.progress) {
        setLidarDownloadProgress(evt.progress);
        setLidarDownloadError(null);
      }
      if (evt.type === 'tileLoaded' || evt.type === 'tileRemoved') {
        setLidarDownloadProgress(null);
        if (evt.type === 'tileLoaded') setLidarDownloadError(null);
        void refreshTiles();
      }
      if (evt.type === 'error') {
        setLidarDownloadProgress(null);
        setLidarDownloadError(evt.error ?? evt.message ?? 'Erreur LiDAR');
      }
    });
  }, [lidarManager, refreshTiles]);

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.lidarTilesHidden = structuredClone(hiddenTiles);
    });
  }, [hiddenTiles, updateProjectControlPanel]);

  const lidarTiles = useMemo(
    () =>
      cachedTiles.map((info) => {
        const id = tileKey(info.coord);
        return {
          id,
          label: customLabels[id] ?? formatLidarTileLabel(info),
          sizeMb: Math.round(info.sizeBytes / (1024 * 1024)),
          year: new Date(info.cachedAt).getFullYear(),
          source: 'LIDAR' as const,
          visible: !hiddenTiles[id],
        };
      }),
    [cachedTiles, customLabels, hiddenTiles],
  );

  const handlers = {
    onLidarTileToggle: useCallback((id: string) => {
      setHiddenTiles((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []),
    onLidarTileOpen: useCallback((id: string) => {
      const info = cachedTiles.find((tile) => tileKey(tile.coord) === id);
      if (info) {
        if (itineraries) {
          syncLidarRouteOverlay(itineraries);
        }
        lidarManager.openViewer(info.coord);
      }
    }, [cachedTiles, itineraries, lidarManager]),
    onLidarTileDelete: useCallback((id: string) => {
      const info = cachedTiles.find((tile) => tileKey(tile.coord) === id);
      if (info) void lidarManager.removeTile(info.coord);
    }, [cachedTiles, lidarManager]),
    onLidarTileRename: useCallback((id: string, name: string) => {
      const next = setLidarTileLabel(id, name);
      setCustomLabels(next);
    }, []),
    onLidarTileDownload: useCallback(() => {
      onToggleLidarDownloadMode?.();
    }, [onToggleLidarDownloadMode]),
  };

  return {
    lidarTiles,
    lidarDownloadProgress,
    lidarDownloadError,
    handlers,
  };
}
