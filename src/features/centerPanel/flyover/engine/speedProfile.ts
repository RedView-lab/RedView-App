import { SPEED_DOUBLING_MIN_S } from '../config';

const RELATIVE_ACCELERATION = Math.LN2 / SPEED_DOUBLING_MIN_S;
const BISECTION_STEPS = 40;
const DURATION_TOLERANCE = 1e-3;

/**
 * Applique la vitesse candidate `k / densité`, plafonnée, puis borne la
 * variation relative de vitesse (|d ln v / dτ| ≤ ln2 / SPEED_DOUBLING_MIN_S)
 * par une passe avant (accélérations) et une passe arrière (freinages), comme
 * un profil de vitesse de véhicule. Les deux passes ne font que baisser des
 * vitesses : la seconde ne peut pas défaire la première. Rend la durée.
 */
function shapeProfile(
  k: number,
  density: Float64Array,
  caps: Float64Array,
  spacingM: number,
  out: Float64Array,
): number {
  const n = density.length;
  for (let i = 0; i < n; i += 1) out[i] = Math.min(k / density[i], caps[i]);
  for (let i = 1; i < n; i += 1) {
    const limit = out[i - 1] * Math.exp((RELATIVE_ACCELERATION * spacingM) / out[i - 1]);
    if (out[i] > limit) out[i] = limit;
  }
  for (let i = n - 2; i >= 0; i -= 1) {
    const limit = out[i + 1] * Math.exp((RELATIVE_ACCELERATION * spacingM) / out[i + 1]);
    if (out[i] > limit) out[i] = limit;
  }
  let duration = 0;
  for (let i = 1; i < n; i += 1) duration += (2 * spacingM) / (out[i - 1] + out[i]);
  return duration;
}

export interface SpeedProfile {
  speedMps: Float64Array;
  durationS: number;
}

/**
 * Courbe de vitesse de lecture (m/s au sol, à 1×) qui tient `targetDurationS` :
 * la densité de temps répartit la durée (plus de temps là où le parcours est
 * sinueux / pentu), `caps` plafonne localement (rotation de cap), et le
 * facteur global est trouvé par dichotomie (durée décroissante en k). Si les
 * plafonds rendent la cible inatteignable, la lecture dure simplement plus.
 */
export function solveSpeedProfile(
  density: Float64Array,
  caps: Float64Array,
  spacingM: number,
  targetDurationS: number,
): SpeedProfile {
  const n = density.length;
  const lengthM = spacingM * (n - 1);
  const speedMps = new Float64Array(n);
  // Densité ≥ 1 ⇒ vitesses ≤ k ⇒ durée ≥ L / k : borne basse sûre.
  let kLow = lengthM / targetDurationS;
  let kHigh = kLow * 2;
  let guard = 0;
  while (shapeProfile(kHigh, density, caps, spacingM, speedMps) > targetDurationS && guard < 24) {
    kLow = kHigh;
    kHigh *= 2;
    guard += 1;
  }
  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const k = Math.sqrt(kLow * kHigh);
    const duration = shapeProfile(k, density, caps, spacingM, speedMps);
    if (Math.abs(duration - targetDurationS) <= targetDurationS * DURATION_TOLERANCE) break;
    if (duration > targetDurationS) kLow = k;
    else kHigh = k;
  }
  const durationS = shapeProfile(Math.sqrt(kLow * kHigh), density, caps, spacingM, speedMps);
  return { speedMps, durationS };
}

/** Temps de lecture cumulé (1×) à chaque échantillon, vitesse linéaire par morceaux. */
export function cumulativePlaybackTime(speedMps: Float64Array, spacingM: number): Float64Array {
  const tau = new Float64Array(speedMps.length);
  for (let i = 1; i < speedMps.length; i += 1) tau[i] = tau[i - 1] + (2 * spacingM) / (speedMps[i - 1] + speedMps[i]);
  return tau;
}
