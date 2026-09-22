import type { Map as MapboxMap } from 'mapbox-gl';

const DEFAULT_EXAGGERATION = 1.5;

export class TerrainManager {
  private map: MapboxMap;
  private sourceId: string;
  private exaggeration = DEFAULT_EXAGGERATION;
  private applied = false;

  constructor(map: MapboxMap, sourceId: string) {
    this.map = map;
    this.sourceId = sourceId;
  }

  /** Idempotent. Safe to call multiple times. */
  init(): void {
    this.applyTerrain();
  }

  private applyTerrain(): void {
    try {
      this.map.setTerrain({
        source: this.sourceId,
        exaggeration: this.exaggeration,
      });
      this.applied = true;
    } catch (error) {
      // setTerrain can throw during sprite storms, stale style graphs,
      // or when the source was removed between check and apply. Don't
      // mark applied=true so subsequent init() calls can retry.
      console.warn('[terrain] setTerrain failed — will retry on next init()', error);
    }
  }

  setSource(sourceId: string): void {
    if (this.sourceId === sourceId && this.applied) return;
    this.sourceId = sourceId;
    this.applyTerrain();
  }

  getSourceId(): string {
    return this.sourceId;
  }

  setExaggeration(value: number): void {
    this.exaggeration = value;
    if (this.applied) this.applyTerrain();
  }

  getExaggeration(): number {
    return this.exaggeration;
  }

  destroy(): void {
    if (!this.applied) return;
    try { this.map.setTerrain(null); } catch { /* map may already be destroyed */ }
    this.applied = false;
  }
}
