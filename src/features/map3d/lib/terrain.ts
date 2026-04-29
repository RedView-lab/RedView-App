import type { Map as MapboxMap } from 'mapbox-gl';

const DEFAULT_EXAGGERATION = 1.5;

function getExaggerationForZoom(zoom: number): number {
  if (zoom <= 12) return 1.5;
  if (zoom <= 14) return 1.8;
  if (zoom <= 16) return 2.2;
  if (zoom <= 18) return 2.8;
  return 3.2;
}

export class TerrainManager {
  private map: MapboxMap;
  private sourceId: string;
  private exaggeration = DEFAULT_EXAGGERATION;
  private applied = false;
  private readonly onZoomEnd = () => {
    const next = getExaggerationForZoom(this.map.getZoom());
    if (next === this.exaggeration) return;
    this.exaggeration = next;
    if (this.applied) this.applyTerrain();
  };

  constructor(map: MapboxMap, sourceId: string) {
    this.map = map;
    this.sourceId = sourceId;
    this.exaggeration = getExaggerationForZoom(this.map.getZoom());
  }

  /** Idempotent. Safe to call multiple times. */
  init(): void {
    if (this.applied) return;
    this.map.on('zoomend', this.onZoomEnd);
    this.onZoomEnd();
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
    this.map.off('zoomend', this.onZoomEnd);
    try { this.map.setTerrain(null); } catch { /* map may already be destroyed */ }
    this.applied = false;
  }
}
