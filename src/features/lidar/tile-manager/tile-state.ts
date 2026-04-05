import type { TileCoord } from '../types/geometry';
import type { LidarTileStatus } from '../types/tile';
import type { DownloadProgress, LidarEventCallback, LidarEvent } from '../types/events';
import { tileCoordKey } from '../processing/coord-transform';

export interface TileState {
  coord: TileCoord;
  status: LidarTileStatus;
  progress?: DownloadProgress;
  error?: string;
}

export class TileStateManager {
  private tiles = new Map<string, TileState>();
  private listeners = new Set<LidarEventCallback>();

  get(coord: TileCoord): TileState | undefined {
    return this.tiles.get(tileCoordKey(coord));
  }

  getAll(): TileState[] {
    return Array.from(this.tiles.values());
  }

  set(coord: TileCoord, status: LidarTileStatus, progress?: DownloadProgress, error?: string): void {
    const key = tileCoordKey(coord);
    this.tiles.set(key, { coord, status, progress, error });
    this.emit({ type: 'progress', tileCoord: coord, progress });
  }

  remove(coord: TileCoord): void {
    const key = tileCoordKey(coord);
    this.tiles.delete(key);
    this.emit({ type: 'tileRemoved', tileCoord: coord });
  }

  has(coord: TileCoord): boolean {
    return this.tiles.has(tileCoordKey(coord));
  }

  subscribe(cb: LidarEventCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: LidarEvent): void {
    for (const cb of this.listeners) {
      cb(event);
    }
  }
}
