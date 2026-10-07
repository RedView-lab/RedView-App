import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import type {
  TileCoord, LidarEvent, LidarEventCallback, CachedTileInfo,
} from '../types';
import { translateAppText } from '@/shared/i18n/config';
import { errorMessage, errorName } from '@/shared/lib/errors';
import { wgs84ToTileCoord, toWgs84, getTileBounds, tileCoordFileName, tileFootprintSuffix } from './coordConvert';
import { resolveFileTileCoord } from './fileTiles';
import { downloadTile, isDownloadCancelledError } from './downloader';
import { deleteTile, listCachedTiles, getStorageUsage } from './storage';
import { buildViewerUrl } from './viewerUrl';

export class LidarManager {
  private listeners: LidarEventCallback[] = [];
  private loadingTiles = new Set<string>();
  private activeControllers = new Map<string, AbortController>();

  async init(): Promise<void> {}

  on(callback: LidarEventCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private emit(event: LidarEvent): void {
    for (const cb of this.listeners) cb(event);
  }

  private tileKey(coord: TileCoord): string {
    return `${coord.xKm}_${coord.yKm}_${coord.projection}${tileFootprintSuffix(coord)}`;
  }

  async downloadTileAtLonLat(lon: number, lat: number, signal?: AbortSignal): Promise<void> {
    const coord = await resolveFileTileCoord(wgs84ToTileCoord(lon, lat), lon, lat);
    return this.downloadTile(coord, signal);
  }

  async downloadTile(coord: TileCoord, signal?: AbortSignal): Promise<void> {
    const key = this.tileKey(coord);
    if (this.loadingTiles.has(key)) return;

    this.loadingTiles.add(key);

    // Chaque téléchargement a son propre AbortController : un signal externe
    // (ou cancelDownload) l'interrompt, les autres téléchargements continuent.
    const controller = new AbortController();
    this.activeControllers.set(key, controller);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      this.emit({
        type: 'progress',
        tileCoord: coord,
        progress: { tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Téléchargement...') },
      });

      await downloadTile(coord, (progress) => {
        this.emit({ type: 'progress', tileCoord: coord, progress });
      }, controller.signal);

      trackAnalyticsEvent({ name: 'lidar_tile_downloaded', data: { territory: coord.territory, outcome: 'ok' } });
      this.emit({ type: 'tileLoaded', tileCoord: coord });
    } catch (err) {
      if (isDownloadCancelledError(err) || controller.signal.aborted) {
        console.log(`[LiDAR] Tile download cancelled (${coord.xKm}, ${coord.yKm})`);
        trackAnalyticsEvent({ name: 'lidar_tile_downloaded', data: { territory: coord.territory, outcome: 'cancelled' } });
        this.emit({ type: 'cancelled', tileCoord: coord });
      } else {
        console.error(`[LiDAR] Failed to download tile (${coord.xKm}, ${coord.yKm}):`, err);
        trackAnalyticsEvent({ name: 'lidar_tile_downloaded', data: { territory: coord.territory, outcome: 'error' } });
        this.emit({ type: 'error', tileCoord: coord, error: errorMessage(err) });
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      this.activeControllers.delete(key);
      this.loadingTiles.delete(key);
    }
  }

  /**
   * Annule le téléchargement en cours. Sans argument, annule tous les
   * téléchargements actifs (l'UI ne lance qu'un téléchargement à la fois).
   */
  cancelDownload(coord?: TileCoord): void {
    if (coord) {
      this.activeControllers.get(this.tileKey(coord))?.abort();
      return;
    }
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
  }

  async removeTile(coord: TileCoord): Promise<void> {
    try {
      await deleteTile(coord);
      this.emit({ type: 'tileRemoved', tileCoord: coord });
    } catch (err) {
      console.error(`[LiDAR] Failed to delete tile (${coord.xKm}, ${coord.yKm}):`, err);
      const hint =
        errorName(err) === 'NoModificationAllowedError'
          ? translateAppText("Fichier en cours d'utilisation (ferme le viewer 3D et réessaie).")
          : err instanceof Error ? err.message : translateAppText('Suppression impossible');
      this.emit({ type: 'error', tileCoord: coord, error: hint });
    }
  }

  isTileLoading(coord: TileCoord): boolean {
    return this.loadingTiles.has(this.tileKey(coord));
  }

  async getCachedTiles(): Promise<CachedTileInfo[]> {
    return listCachedTiles();
  }

  async getStorageUsage(): Promise<{ used: number; quota: number }> {
    return getStorageUsage();
  }

  getTileCenter(coord: TileCoord): [number, number] {
    const { minX, minY, maxX, maxY } = getTileBounds(coord);
    return toWgs84((minX + maxX) / 2, (minY + maxY) / 2, coord.projection);
  }

  getTileFileName(coord: TileCoord): string {
    return tileCoordFileName(coord);
  }

  openViewer(coord: TileCoord): void {
    const url = buildViewerUrl(coord);
    window.open(url, '_blank');
  }

  destroy(): void {
    this.cancelDownload();
    this.loadingTiles.clear();
    this.listeners = [];
  }
}
