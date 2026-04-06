import type {
  TileCoord, LidarEvent, LidarEventCallback, CachedTileInfo,
} from './types';
import { wgs84ToTileCoord, toWgs84, buildTileFileName } from './coordConvert';
import { downloadTile } from './downloader';
import { deleteTile, listCachedTiles, getStorageUsage } from './storage';

export class LidarManager {
  private listeners: LidarEventCallback[] = [];
  private loadingTiles = new Set<string>();

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
    return `${coord.xKm}_${coord.yKm}_${coord.projection}`;
  }

  async downloadTileAtLonLat(lon: number, lat: number): Promise<void> {
    const coord = wgs84ToTileCoord(lon, lat);
    return this.downloadTile(coord);
  }

  async downloadTile(coord: TileCoord): Promise<void> {
    const key = this.tileKey(coord);
    if (this.loadingTiles.has(key)) return;

    this.loadingTiles.add(key);

    try {
      this.emit({
        type: 'progress',
        tileCoord: coord,
        progress: { tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: 'Téléchargement...' },
      });

      await downloadTile(coord, (progress) => {
        this.emit({ type: 'progress', tileCoord: coord, progress });
      });

      this.emit({ type: 'tileLoaded', tileCoord: coord });
    } catch (err: any) {
      console.error(`[LiDAR] Failed to download tile (${coord.xKm}, ${coord.yKm}):`, err);
      this.emit({ type: 'error', tileCoord: coord, error: err.message });
    } finally {
      this.loadingTiles.delete(key);
    }
  }

  async removeTile(coord: TileCoord): Promise<void> {
    await deleteTile(coord);
    this.emit({ type: 'tileRemoved', tileCoord: coord });
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
    const centerX = coord.xKm * 1000 + 500;
    const centerY = coord.yKm * 1000 + 500;
    return toWgs84(centerX, centerY, coord.projection);
  }

  getTileFileName(coord: TileCoord): string {
    return `${buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef)}.copc.laz`;
  }

  openViewer(coord: TileCoord): void {
    const url = `/viewer.html?x=${coord.xKm}&y=${coord.yKm}&crs=${coord.projection}&alt=${coord.altRef}`;
    window.open(url, '_blank');
  }

  destroy(): void {
    this.loadingTiles.clear();
    this.listeners = [];
  }
}
