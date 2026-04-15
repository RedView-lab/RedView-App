import type { PredictionPoint } from '../types';
import type { CheckpointRow } from './types';

/**
 * Linearly interpolate a value between two points at a given distance.
 */
function lerp(
  d: number,
  p0: PredictionPoint,
  p1: PredictionPoint,
  field: keyof PredictionPoint,
): number {
  const v0 = (p0[field] as number) ?? 0;
  const v1 = (p1[field] as number) ?? 0;
  if (p1.distance_m === p0.distance_m) return v0;
  const t = (d - p0.distance_m) / (p1.distance_m - p0.distance_m);
  return v0 + t * (v1 - v0);
}

/**
 * Aggregate stats for a section of points between two distances.
 */
function aggregateSection(
  points: PredictionPoint[],
  startIdx: number,
  startDistM: number,
  endDistM: number,
): Pick<CheckpointRow, 'elevGainM' | 'elevLossM' | 'avgGradientPct' | 'avgPowerW'> {
  let elevGain = 0;
  let elevLoss = 0;
  let gradientSum = 0;
  let powerSum = 0;
  let count = 0;

  // Walk through all points within [startDistM, endDistM]
  let prevElev: number | null = null;
  for (let i = startIdx; i < points.length; i++) {
    const p = points[i];
    if (p.distance_m < startDistM) continue;
    if (p.distance_m > endDistM) break;
    if (prevElev !== null) {
      const dElev = p.elevation_m - prevElev;
      if (dElev > 0) elevGain += dElev;
      else elevLoss += Math.abs(dElev);
    }
    prevElev = p.elevation_m;
    gradientSum += p.gradient_pct;
    powerSum += p.predicted_power_w;
    count++;
  }

  return {
    elevGainM: Math.round(elevGain),
    elevLossM: Math.round(elevLoss),
    avgGradientPct: count > 0 ? gradientSum / count : 0,
    avgPowerW: count > 0 ? powerSum / count : 0,
  };
}

/**
 * Build checkpoint rows at regular intervals from the prediction points array.
 *
 * Uses cumulative riding time (sum of segment_time_s) rather than elapsed_time_s,
 * so the exported times reflect pure ride time without stops.
 *
 * The first checkpoint is always km 0 (start). Intermediate checkpoints are
 * placed at every `intervalKm`. The final checkpoint is always the finish,
 * even if it does not land on a multiple of `intervalKm`.
 */
export function buildCheckpoints(
  points: PredictionPoint[],
  intervalKm: number,
): CheckpointRow[] {
  if (points.length === 0) return [];

  const totalDistM = points[points.length - 1].distance_m;

  // Pre-compute cumulative riding time (excludes stop durations)
  const ridingTimeS = new Float64Array(points.length);
  ridingTimeS[0] = 0;
  for (let i = 1; i < points.length; i++) {
    ridingTimeS[i] = ridingTimeS[i - 1] + (points[i].segment_time_s ?? 0);
  }

  const checkpoints: CheckpointRow[] = [];

  // Helper: find the pair of points surrounding a given distance
  let searchIdx = 0;
  function findBracket(distM: number): [number, PredictionPoint, PredictionPoint] {
    while (searchIdx < points.length - 1 && points[searchIdx + 1].distance_m < distM) {
      searchIdx++;
    }
    return [searchIdx, points[searchIdx], points[Math.min(searchIdx + 1, points.length - 1)]];
  }

  /** Interpolate cumulative riding time at a given distance */
  function lerpRidingTime(distM: number, bracketIdx: number, pA: PredictionPoint, pB: PredictionPoint): number {
    const rA = ridingTimeS[bracketIdx];
    const rB = ridingTimeS[Math.min(bracketIdx + 1, points.length - 1)];
    if (pB.distance_m === pA.distance_m) return rA;
    const t = (distM - pA.distance_m) / (pB.distance_m - pA.distance_m);
    return rA + t * (rB - rA);
  }

  // Start checkpoint (km 0)
  const p0 = points[0];
  checkpoints.push({
    km: 0,
    distanceCumM: 0,
    elapsedTimeS: 0,
    segmentTimeS: 0,
    avgSpeedKmh: 0,
    elevationM: Math.round(p0.elevation_m),
    elevGainM: 0,
    elevLossM: 0,
    avgGradientPct: 0,
    avgPowerW: 0,
  });

  // Intermediate checkpoints every intervalKm
  let cpKm = intervalKm;
  let prevDistM = 0;
  let prevRidingS = 0;
  let prevSearchIdx = 0;

  while (cpKm * 1000 < totalDistM) {
    const targetDistM = cpKm * 1000;
    searchIdx = prevSearchIdx;
    const [bracketIdx, pA, pB] = findBracket(targetDistM);

    const cumRidingS = lerpRidingTime(targetDistM, bracketIdx, pA, pB);
    const elevationM = lerp(targetDistM, pA, pB, 'elevation_m');
    const segmentTimeS = cumRidingS - prevRidingS;
    const sectionDistKm = (targetDistM - prevDistM) / 1000;
    const sectionTimeH = segmentTimeS / 3600;

    const agg = aggregateSection(points, prevSearchIdx, prevDistM, targetDistM);

    checkpoints.push({
      km: cpKm,
      distanceCumM: targetDistM,
      elapsedTimeS: cumRidingS,
      segmentTimeS,
      avgSpeedKmh: sectionTimeH > 0 ? sectionDistKm / sectionTimeH : 0,
      elevationM: Math.round(elevationM),
      ...agg,
    });

    prevDistM = targetDistM;
    prevRidingS = cumRidingS;
    prevSearchIdx = bracketIdx;
    cpKm += intervalKm;
  }

  // Finish checkpoint (always included)
  const pLast = points[points.length - 1];
  const finishKm = totalDistM / 1000;
  const totalRidingS = ridingTimeS[points.length - 1];
  // Skip if finish coincides with last interval checkpoint
  if (checkpoints.length === 0 || Math.abs(checkpoints[checkpoints.length - 1].distanceCumM - totalDistM) > 10) {
    const segmentTimeS = totalRidingS - prevRidingS;
    const sectionDistKm = (totalDistM - prevDistM) / 1000;
    const sectionTimeH = segmentTimeS / 3600;

    const agg = aggregateSection(points, prevSearchIdx, prevDistM, totalDistM);

    checkpoints.push({
      km: Math.round(finishKm * 10) / 10,
      distanceCumM: totalDistM,
      elapsedTimeS: totalRidingS,
      segmentTimeS,
      avgSpeedKmh: sectionTimeH > 0 ? sectionDistKm / sectionTimeH : 0,
      elevationM: Math.round(pLast.elevation_m),
      ...agg,
    });
  }

  return checkpoints;
}
