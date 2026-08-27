import type { BrouterRoute } from '../brouter';
import {
  buildElevationSamplesFromPoints,
  buildRouteProfileFromSamples,
  computeGradientPercentAtIndex,
  interpolateMissingElevations,
  smoothElevations,
} from './elevation';
import { parseMessages } from './parser';
import { sampleTerrainElevationsAtPoints } from './terrainTiles';
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

export function sampleRouteProfileWithTerrain(
  points: RoutePointInput[],
  queryEle: (lng: number, lat: number) => number | null | undefined,
  minCoverage = 0.6,
): RouteProfilePoint[] | null {
  if (points.length < 2) return null;

  let coverage = 0;
  const sampledElevations = points.map((point) => {
    const elevationM = queryEle(point.lon, point.lat);
    if (elevationM != null && Number.isFinite(elevationM)) {
      coverage++;
      return elevationM;
    }
    return null;
  });

  if (coverage / points.length < minCoverage) return null;

  const filledElevations = interpolateMissingElevations(sampledElevations);
  if (!filledElevations) return null;

  return extractRouteProfileFromPoints(
    points.map((point, index) => ({
      ...point,
      elevationM: filledElevations[index],
    })),
  );
}

export function extractRouteProfileFromBrouter(
  route: BrouterRoute,
): RouteProfilePoint[] | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;
  return buildRouteProfile(rows);
}

export function refineRouteProfileWithTerrain(
  route: BrouterRoute,
  queryEle: (lng: number, lat: number) => number | null | undefined,
): RouteProfilePoint[] | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;

  let coverage = 0;
  for (const row of rows) {
    const elevation = queryEle(row.lon, row.lat);
    if (elevation != null && Number.isFinite(elevation)) {
      row.ele = elevation;
      coverage++;
    }
  }
  if (coverage / rows.length < 0.6) return null;

  return buildRouteProfile(rows);
}

export async function refineRouteProfileWithIgnAltimetry(
  route: BrouterRoute,
  signal?: AbortSignal,
): Promise<RouteProfilePoint[] | null> {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;

  const elevations = await sampleTerrainElevationsAtPoints(rows, signal);
  let coverage = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const elevation = elevations[index];
    if (elevation != null && Number.isFinite(elevation)) {
      rows[index]!.ele = elevation;
      coverage += 1;
    }
  }

  if (coverage / rows.length < 0.6) return null;
  return buildRouteProfile(rows);
}