// ============================================
// LiDAR viewer tools — ground profile along a polyline
// ============================================

import { steepestHeldSlope } from './fallLine';
import type { DrapedSample, TerrainField } from './terrainField';

export interface ProfileSample extends DrapedSample {
  /** Signed slope along the path (positive uphill), degrees. */
  gradeDeg: number;
}

export interface ProfileResult {
  samples: ProfileSample[];
  /** Horizontal length, m. */
  lengthM: number;
  /** Length along the ground surface, m. */
  surfaceLengthM: number;
  gainM: number;
  lossM: number;
  minAltitudeM: number;
  maxAltitudeM: number;
  /** Steepest slope held over 10 m, degrees. */
  maxSlopeDeg: number;
  /** Horizontal distance of each polyline vertex along the path, m. */
  vertexDistancesM: number[];
}

/** At most this many samples per profile. */
const MAX_SAMPLES = 2500;
/** Elevation changes smaller than this are DTM noise, not climbing (m). */
const GAIN_DEADBAND_M = 1;
/** Half-window of the slope read along the path, m. */
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

  // Gain/loss with a deadband: counted once the change exceeds it.
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
