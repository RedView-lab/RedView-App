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

  /** Idempotent. Peut être appelé plusieurs fois sans risque. */
  init(): void {
    this.applyTerrain();
  }

  /**
   * Lie le terrain, ou ne fait rien quand le style l'a déjà avec la même source
   * et la même exagération. Les garde-fous anti-plat l'appellent à chaque
   * `styledata` / inactivité / battement de cœur : un `setTerrain`
   * inconditionnel salit le style et fait rééchantillonner par Mapbox son
   * altitude moyenne à l'image suivante au lieu de toutes les 500 ms — ~11 appels
   * par seconde pendant un geste de zoom, avec un cadrage de caméra décalé à
   * chaque fois.
   */
  private applyTerrain(): void {
    try {
      const current = this.map.getTerrain();
      if (current?.source === this.sourceId && current.exaggeration === this.exaggeration) {
        this.applied = true;
        return;
      }
      this.map.setTerrain({
        source: this.sourceId,
        exaggeration: this.exaggeration,
      });
      this.applied = true;
    } catch (error) {
      // setTerrain peut lever une exception pendant des tempêtes de sprites, sur
      // un graphe de style périmé, ou quand la source a été retirée entre le
      // contrôle et l'application. On ne marque pas applied=true, pour que les
      // appels suivants à init() puissent réessayer.
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
    try { this.map.setTerrain(null); } catch { /* la carte est peut-être déjà détruite */ }
    this.applied = false;
  }
}
