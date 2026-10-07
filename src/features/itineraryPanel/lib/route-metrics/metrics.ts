import type { BrouterRoute } from '../brouter';
import { buildElevationSamplesFromPoints, computeAscentDescentFromElevations, haversineM, smoothElevationValues } from './elevation';
import { parseMessages } from './parser';
import { isOffroadSurface, isPavedSurface } from './surface';
import type { RouteElevationMetrics, RoutePointInput, RouteSurfaceMetrics } from './types';

export function computeRouteElevationMetrics(
  points: RoutePointInput[],
): RouteElevationMetrics | null {
  const { samples, totalDistanceM } = buildElevationSamplesFromPoints(points);
  if (samples.length < 2) return null;

  const smoothedElevations = smoothElevationValues(
    samples.map((sample) => sample.ele),
    5,
  );
  const { ascent, descent } = computeAscentDescentFromElevations(smoothedElevations, 2);

  return {
    distanceM: totalDistanceM,
    ascentM: Math.round(ascent),
    descentM: Math.round(descent),
    avgSlopePercent: totalDistanceM > 0 ? (ascent / totalDistanceM) * 100 : 0,
  };
}

export function computeRouteSurfaceMetricsFromBrouter(
  route: BrouterRoute,
): RouteSurfaceMetrics | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;

  let totalDist = 0;
  let tarmacDist = 0;
  let offroadDist = 0;
  for (let i = 1; i < rows.length; i++) {
    const distance = rows[i].segDistM;
    totalDist += distance;
    if (isPavedSurface(rows[i].surface)) tarmacDist += distance;
    else if (isOffroadSurface(rows[i].surface)) offroadDist += distance;
  }
  if (totalDist <= 0) totalDist = route.distanceM;

  const classifiedDist = tarmacDist + offroadDist;
  return {
    distanceM: totalDist,
    tarmacPercent: classifiedDist > 0 ? (tarmacDist / classifiedDist) * 100 : 0,
    offroadPercent: classifiedDist > 0 ? (offroadDist / classifiedDist) * 100 : 0,
  };
}

export function computeRouteSurfaceMetricsFromPoints(
  points: RoutePointInput[],
): RouteSurfaceMetrics | null {
  if (points.length < 2) return null;

  let totalDist = 0;
  let tarmacDist = 0;
  let offroadDist = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const segDist =
      Number.isFinite(curr.distanceM) &&
      Number.isFinite(prev.distanceM) &&
      (curr.distanceM as number) >= (prev.distanceM as number)
        ? (curr.distanceM as number) - (prev.distanceM as number)
        : haversineM(prev, curr);

    totalDist += segDist;
    const surface = curr.surface ?? prev.surface;
    if (isPavedSurface(surface)) {
      tarmacDist += segDist;
    } else if (isOffroadSurface(surface)) {
      offroadDist += segDist;
    }
  }

  const classifiedDist = tarmacDist + offroadDist;
  if (classifiedDist <= 0) return null;

  return {
    distanceM: totalDist,
    tarmacPercent: (tarmacDist / classifiedDist) * 100,
    offroadPercent: (offroadDist / classifiedDist) * 100,
  };
}

