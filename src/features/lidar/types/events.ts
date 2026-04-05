import type { TileCoord } from './geometry';
import type { LidarTileStatus } from './tile';

export interface DownloadProgress {
  tileCoord: TileCoord;
  bytesDownloaded: number;
  totalBytes: number;
  phase: LidarTileStatus;
  message?: string;
  percent?: number;
}

export type LidarEventType = 'progress' | 'tileLoaded' | 'tileRemoved' | 'error';

export interface LidarEvent {
  type: LidarEventType;
  tileCoord?: TileCoord;
  progress?: DownloadProgress;
  error?: string;
}

export type LidarEventCallback = (event: LidarEvent) => void;
