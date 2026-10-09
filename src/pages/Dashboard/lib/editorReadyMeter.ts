/**
 * Temps d'ouverture perçu de l'éditeur (mesure d'audience `editor_ready`) :
 * de l'ouverture d'un projet — ou du chargement de la page pour un lien direct
 * (`cold`) — jusqu'à la première carte 3D prête (statut `map` passé par
 * `loading` puis `ready`). Les Web Vitals ne voient pas la carte WebGL.
 * Une ouverture pendant laquelle l'onglet a été masqué n'est pas comptée :
 * sans image affichée, Mapbox ne charge rien et la durée ne dit rien.
 */

export interface EditorReadySample {
  ms: number;
  cold: boolean;
  /** Prête par le plafond de 12 s : sources encore en chargement ; absent si Mapbox a fini. */
  cappedWaiting?: string;
}

const MAX_MEASURED_MS = 180_000;

export class EditorReadyMeter {
  private startedAt: number | null = null;
  private cold = false;
  private sawLoading = false;
  private hidden = false;

  /** `now` en ms sur l'horloge de `performance.now()` ; `cold` : mesuré depuis le début de la navigation (0). */
  start(now: number, cold: boolean): void {
    this.startedAt = cold ? 0 : now;
    this.cold = cold;
    this.sawLoading = false;
    this.hidden = false;
  }

  markHidden(): void {
    if (this.startedAt !== null) this.hidden = true;
  }

  cancel(): void {
    this.startedAt = null;
  }

  /** Statut de la carte ; renvoie la mesure à la première carte prête. */
  observe(state: string | null | undefined, now: number, cappedWaiting?: string): EditorReadySample | null {
    if (this.startedAt === null) return null;
    if (state === 'loading') this.sawLoading = true;
    if (state !== 'ready' || !this.sawLoading) return null;
    const ms = now - this.startedAt;
    const sample: EditorReadySample = { ms, cold: this.cold, ...(cappedWaiting ? { cappedWaiting } : {}) };
    const valid = !this.hidden && ms >= 0 && ms <= MAX_MEASURED_MS;
    this.startedAt = null;
    return valid ? sample : null;
  }
}
