import type { TileCoord } from '../types/geometry';
import type { TileStateManager } from './tile-state';
import type { ProcessedTile } from './tile-lifecycle';
import { tileCoordKey } from '../processing/coord-transform';
import { processTile } from './tile-lifecycle';

const MAX_CONCURRENT_DOWNLOADS = 3;

export class TileSelector {
  private processing = new Map<string, AbortController>();
  private queued: TileCoord[] = [];
  private active = 0;
  private state: TileStateManager;
  private onTileReady: (tile: ProcessedTile) => void;

  constructor(state: TileStateManager, onTileReady: (tile: ProcessedTile) => void) {
    this.state = state;
    this.onTileReady = onTileReady;
  }

  enqueue(coord: TileCoord): void {
    const key = tileCoordKey(coord);
    if (this.state.has(coord) || this.processing.has(key)) return;
    this.state.set(coord, 'available');
    this.queued.push(coord);
    this.processNext();
  }

  cancel(coord: TileCoord): void {
    const key = tileCoordKey(coord);
    const controller = this.processing.get(key);
    if (controller) {
      controller.abort();
      this.processing.delete(key);
    }
    this.queued = this.queued.filter(c => tileCoordKey(c) !== key);
    this.state.remove(coord);
  }

  cancelAll(): void {
    for (const controller of this.processing.values()) {
      controller.abort();
    }
    this.processing.clear();
    this.queued = [];
  }

  private processNext(): void {
    while (this.active < MAX_CONCURRENT_DOWNLOADS && this.queued.length > 0) {
      const coord = this.queued.shift()!;
      const key = tileCoordKey(coord);
      const controller = new AbortController();
      this.processing.set(key, controller);
      this.active++;

      processTile(coord, this.state)
        .then((result) => {
          if (!controller.signal.aborted) {
            this.onTileReady(result);
          }
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            this.state.set(coord, 'error', undefined, String(err));
          }
        })
        .finally(() => {
          this.processing.delete(key);
          this.active--;
          this.processNext();
        });
    }
  }
}
