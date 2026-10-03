import type { Map as MapboxMap } from 'mapbox-gl';
import { smootherstep } from '../engine/springs';

/**
 * Champ de vision vertical de la caméra Mapbox. Pas d'API publique : on passe
 * par `map.transform.fov` (degrés, borné à [0.01, 60] par Mapbox), détecté à
 * l'usage — sans lui le flyover garde simplement le champ par défaut.
 * Les transitions sont animées (smootherstep) et annulables.
 */

interface FovTransform {
  fov: number;
}

function fovTransform(map: MapboxMap): FovTransform | null {
  const transform = (map as unknown as { transform?: Partial<FovTransform> }).transform;
  if (!transform || typeof transform.fov !== 'number' || !Number.isFinite(transform.fov)) return null;
  return transform as FovTransform;
}

export class FovController {
  private readonly map: MapboxMap;
  private frameId = 0;
  private original: number | null = null;

  constructor(map: MapboxMap) {
    this.map = map;
  }

  get supported(): boolean {
    return fovTransform(this.map) != null;
  }

  /** Va vers `fovDeg` en `durationMs` (instantané si 0) ; mémorise le champ d'origine au premier appel. */
  animateTo(fovDeg: number, durationMs: number): void {
    const transform = fovTransform(this.map);
    if (!transform) return;
    if (this.original == null) this.original = transform.fov;
    this.run(transform, fovDeg, durationMs);
  }

  /** Rend le champ d'origine (animé) et oublie l'état. */
  restore(durationMs: number): void {
    const transform = fovTransform(this.map);
    const original = this.original;
    this.original = null;
    if (!transform || original == null) {
      this.cancel();
      return;
    }
    this.run(transform, original, durationMs);
  }

  cancel(): void {
    if (this.frameId) window.cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  private run(transform: FovTransform, to: number, durationMs: number): void {
    this.cancel();
    const from = transform.fov;
    if (!(durationMs > 0) || Math.abs(from - to) < 1e-3) {
      this.apply(transform, to);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      this.apply(transform, from + (to - from) * smootherstep(t));
      this.frameId = t < 1 ? window.requestAnimationFrame(step) : 0;
    };
    this.frameId = window.requestAnimationFrame(step);
  }

  private apply(transform: FovTransform, fovDeg: number): void {
    try {
      transform.fov = fovDeg;
      this.map.triggerRepaint();
    } catch {
      /* carte détruite */
    }
  }
}
