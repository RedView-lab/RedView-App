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
    if (this.applied) return;
    this.applyTerrain();
    this.applied = true;
  }

  private applyTerrain(): void {
    this.map.setTerrain({
      source: this.sourceId,
      exaggeration: this.exaggeration,
    });
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
