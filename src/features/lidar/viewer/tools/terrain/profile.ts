// ============================================
// Outils du viewer LiDAR — profil du sol le long d'une polyligne
// ============================================

import { steepestHeldSlope } from './fallLine';
import type { DrapedSample, TerrainField } from './terrainField';

export interface ProfileSample extends DrapedSample {
  /** Pente signée le long du chemin (positive en montée), degrés. */
  gradeDeg: number;
}

export interface ProfileResult {
  samples: ProfileSample[];
  /** Longueur horizontale, m. */
  lengthM: number;
  /** Longueur le long de la surface du sol, m. */
  surfaceLengthM: number;
  gainM: number;
  lossM: number;
  minAltitudeM: number;
  maxAltitudeM: number;
  /** Pente la plus forte tenue sur 10 m, degrés. */
  maxSlopeDeg: number;
  /** Distance horizontale de chaque sommet de la polyligne le long du chemin, m. */
  vertexDistancesM: number[];
}

/** Nombre maximal d'échantillons par profil. */
const MAX_SAMPLES = 2500;
/** Les variations d'altitude plus petites que ceci sont du bruit du MNT, pas de la montée (m). */
const GAIN_DEADBAND_M = 1;
/** Demi-fenêtre de la pente lue le long du chemin, m. */
const GRADE_HALF_WINDOW_M = 5;
const STEEP_WINDOW_M = 10;

type PlanPoint = { projX: number; projY: number };

export function computeProfile(field: TerrainField, vertices: readonly PlanPoint[]): ProfileResult | null {
  if (vertices.length < 2) return null;
  const vertexDistancesM = [0];
  let total = 0;
  for (let k = 1; k < vertices.length; k++) {
    total += Math.hypot(vertices[k]!.projX - vertices[k - 1]!.projX, vertices[k]!.projY - vertices[k - 1]!.projY);
    vertexDistancesM.push(total);
  }
  if (total <= 0) return null;
  const draped = field.drape(vertices, Math.max(field.cell * 0.5, total / MAX_SAMPLES));
  if (draped.length < 2) return null;

  const samples: ProfileSample[] = new Array(draped.length);
  let lo = 0;
  let hi = 0;
  let minAltitude = Infinity;
  let maxAltitude = -Infinity;
  for (let i = 0; i < draped.length; i++) {
    const s = draped[i]!;
    while (draped[lo]!.distanceM < s.distanceM - GRADE_HALF_WINDOW_M) lo++;
    while (hi < draped.length - 1 && draped[hi + 1]!.distanceM <= s.distanceM + GRADE_HALF_WINDOW_M) hi++;
    const a = draped[lo]!;
    const b = draped[Math.max(hi, i)]!;
    const run = b.distanceM - a.distanceM;
    const gradeDeg = run > 0 ? (Math.atan((b.altitudeM - a.altitudeM) / run) * 180) / Math.PI : 0;
    samples[i] = { ...s, gradeDeg };
    minAltitude = Math.min(minAltitude, s.altitudeM);
    maxAltitude = Math.max(maxAltitude, s.altitudeM);
  }

  // Dénivelé positif/négatif avec une zone morte : compté une fois que la variation la dépasse.
  let gain = 0;
  let loss = 0;
  let reference = samples[0]!.altitudeM;
  for (const s of samples) {
    const delta = s.altitudeM - reference;
    if (delta >= GAIN_DEADBAND_M) {
      gain += delta;
      reference = s.altitudeM;
    } else if (delta <= -GAIN_DEADBAND_M) {
      loss -= delta;
      reference = s.altitudeM;
    }
  }

  const last = samples[samples.length - 1]!;
  return {
    samples,
    lengthM: last.distanceM,
    surfaceLengthM: last.surfaceDistanceM,
    gainM: gain,
    lossM: loss,
    minAltitudeM: minAltitude,
    maxAltitudeM: maxAltitude,
    maxSlopeDeg: steepestHeldSlope(samples, STEEP_WINDOW_M),
    vertexDistancesM,
  };
}
