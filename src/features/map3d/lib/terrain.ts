import type { Map as MapboxMap } from 'mapbox-gl';

const DEFAULT_EXAGGERATION = 1.5;

// Zoom-dependent exaggeration: at high zoom, the camera is close and
// local slopes appear gentler than at overview zoom. Progressively
// increasing exaggeration compensates so mountains DON'T look flat.
function exaggerationForZoom(zoom: number): number {
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
  private zoomHandler: (() => void) | null = null;

  constructor(map: MapboxMap, sourceId: string) {
    this.map = map;
    this.sourceId = sourceId;
  }

  init(): void {
    // Apply initial exaggeration based on current zoom
    this.exaggeration = exaggerationForZoom(this.map.getZoom());
    this.applyTerrain();

    // Update exaggeration dynamically as user zooms
    if (!this.zoomHandler) {
      this.zoomHandler = () => {
        const newExagg = exaggerationForZoom(this.map.getZoom());
        if (Math.abs(newExagg - this.exaggeration) > 0.05) {
          console.log(
            `[terrain] %c EXAGGERATION %c z=${this.map.getZoom().toFixed(1)} → exagg=${newExagg}`,
            'background:#9C27B0;color:#fff;padding:2px 4px;border-radius:2px', ''
          );
          this.exaggeration = newExagg;
          this.applyTerrain();
        }
      };
      this.map.on('zoomend', this.zoomHandler);
    }
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
    if (this.zoomHandler) {
      this.map.off('zoomend', this.zoomHandler);
      this.zoomHandler = null;
    }
    this.map.setTerrain(null);
  }
}
