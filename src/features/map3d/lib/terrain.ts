import type { Map as MapboxMap } from 'mapbox-gl';

const DEFAULT_EXAGGERATION = 0.8;

export class TerrainManager {
  private map: MapboxMap;
  private sourceId: string;
  private exaggeration = DEFAULT_EXAGGERATION;

  constructor(map: MapboxMap, sourceId: string) {
    this.map = map;
    this.sourceId = sourceId;
  }

  init(): void {
    this.applyTerrain();
  }

  private applyTerrain(): void {
    this.map.setTerrain({
      source: this.sourceId,
      exaggeration: this.exaggeration,
    });
  }

  setExaggeration(value: number): void {
    this.exaggeration = value;
    this.applyTerrain();
  }

  getExaggeration(): number {
    return this.exaggeration;
  }

  destroy(): void {
    this.map.setTerrain(null);
  }
}
