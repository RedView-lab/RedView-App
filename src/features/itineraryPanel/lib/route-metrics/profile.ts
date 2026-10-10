import type { BrouterRoute } from '../brouter';
import {
  buildElevationSamplesFromPoints,
  buildRouteProfileFromSamples,
  computeGradientPercentAtIndex,
  smoothElevations,
} from './elevation';
import { parseMessages } from './parser';
import type { RoutePointInput, RouteProfilePoint } from './types';

function buildRouteProfile(rows: Array<{
  lat: number;
  lon: number;
  segDistM: number;
  ele: number;
}>): RouteProfilePoint[] {
  const smoothed = smoothElevations(rows, 5);
  const distancesM = new Array<number>(rows.length).fill(0);

  for (let i = 1; i < rows.length; i++) {
    distancesM[i] = distancesM[i - 1] + Math.max(0, rows[i].segDistM);
  }

  return rows.map((row, index) => ({
    lat: row.lat,
    lon: row.lon,
    distanceM: distancesM[index],
    elevationM: smoothed[index],
    gradientPct: computeGradientPercentAtIndex(distancesM, smoothed, index),
  }));
}

export function extractRouteProfileFromPoints(
  points: RoutePointInput[],
): RouteProfilePoint[] | null {
  const { samples } = buildElevationSamplesFromPoints(points);
  if (samples.length < 2) return null;
  return buildRouteProfileFromSamples(samples);
}

export function extractRouteProfileFromBrouter(
  route: BrouterRoute,
): RouteProfilePoint[] | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;
  return buildRouteProfile(rows);
}
