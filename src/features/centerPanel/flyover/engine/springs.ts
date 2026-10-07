/**
 * Lissages temporels exacts quel que soit le pas de temps (aucune dépendance
 * au framerate) : ressort critiquement amorti réglé par sa demi-vie
 * (« Spring-It-On », D. Holden ; même famille que SmoothDamp, GPG4) et
 * courbes d'accélération.
 */

const LN2 = Math.LN2;

export interface SpringState {
  value: number;
  velocity: number;
}

/**
 * Avance d'un pas `dt` un ressort critiquement amorti vers `target` : rejoint
 * la cible le plus vite possible sans la dépasser. Solution analytique, donc
 * identique en 1 pas de 50 ms ou en 3 pas de 16,7 ms.
 */
export function stepCriticalSpring(state: SpringState, target: number, halfLifeS: number, dt: number): void {
  if (!(halfLifeS > 0)) {
    state.value = target;
    state.velocity = 0;
    return;
  }
  const y = (2 * LN2) / halfLifeS;
  const j0 = state.value - target;
  const j1 = state.velocity + j0 * y;
  const decay = Math.exp(-y * dt);
  state.value = decay * (j0 + j1 * dt) + target;
  state.velocity = decay * (state.velocity - j1 * y * dt);
}

/** Lissage exponentiel exact (sans vitesse) : `current` → `target` avec la demi-vie donnée. */
export function approachExponential(current: number, target: number, halfLifeS: number, dt: number): number {
  if (!(halfLifeS > 0)) return target;
  return target + (current - target) * Math.exp((-LN2 * dt) / halfLifeS);
}

function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** 3x² − 2x³ : dérivée nulle aux deux bouts. */
export function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** 6x⁵ − 15x⁴ + 10x³ : dérivées première et seconde nulles aux deux bouts. */
export function smootherstep(x: number): number {
  const t = clamp01(x);
  return t * t * t * (t * (6 * t - 15) + 10);
}

/** Primitive de `smoothstep` sur [0, x] (x borné à [0, 1]). */
export function smoothstepIntegral(x: number): number {
  const t = clamp01(x);
  return t * t * t - (t * t * t * t) / 2;
}
