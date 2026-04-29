import type { BrouterRoute } from '../brouter';
import {
  buildElevationSamplesFromPoints,
  computeAscentDescent,
  computeAscentDescentFromElevations,
  smoothElevationValues,
  smoothElevations,
} from './elevation';
import { parseMessages } from './parser';
import type {
  ParsedRow,
  RouteElevationMetrics,
  RouteMetrics,
  RoutePointInput,
  RouteSurfaceMetrics,
} from './types';

function aggregate(rows: ParsedRow[], totalDistFallback: number): RouteMetrics {
  const smoothed = smoothElevations(rows, 5);
  const { ascent, descent } = computeAscentDescent(smoothed, 1);

  let totalDist = 0;
  let tarmacDist = 0;
  let offroadDist = 0;
  for (let i = 1; i < rows.length; i++) {
    const distance = rows[i].segDistM;
    totalDist += distance;
    if (rows[i].surface === 'tarmac') tarmacDist += distance;
    else if (rows[i].surface === 'offroad') offroadDist += distance;
  }
  if (totalDist === 0) totalDist = totalDistFallback;

  const classifiedDist = tarmacDist + offroadDist;
  return {
    distanceM: totalDist,
    ascentM: ascent,
    descentM: descent,
    avgSlopePercent: totalDist > 0 ? (ascent / totalDist) * 100 : 0,
    tarmacPercent: classifiedDist > 0 ? (tarmacDist / classifiedDist) * 100 : 0,
    offroadPercent: classifiedDist > 0 ? (offroadDist / classifiedDist) * 100 : 0,
  };
}

export function computeRouteElevationMetrics(
  points: RoutePointInput[],
): RouteElevationMetrics | null {
  const { samples, totalDistanceM } = buildElevationSamplesFromPoints(points);
  if (samples.length < 2) return null;

  const smoothedElevations = smoothElevationValues(
    samples.map((sample) => sample.ele),
    5,
  );
  const { ascent, descent } = computeAscentDescentFromElevations(smoothedElevations, 1);

  return {
    distanceM: totalDistanceM,
    ascentM: ascent,
    descentM: descent,
    avgSlopePercent: totalDistanceM > 0 ? (ascent / totalDistanceM) * 100 : 0,
  };
}

export function computeRouteMetricsFromBrouter(route: BrouterRoute): RouteMetrics | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;
  return aggregate(rows, route.distanceM);
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
    if (rows[i].surface === 'tarmac') tarmacDist += distance;
    else if (rows[i].surface === 'offroad') offroadDist += distance;
  }
  if (totalDist <= 0) totalDist = route.distanceM;

  const classifiedDist = tarmacDist + offroadDist;
  return {
    distanceM: totalDist,
    tarmacPercent: classifiedDist > 0 ? (tarmacDist / classifiedDist) * 100 : 0,
    offroadPercent: classifiedDist > 0 ? (offroadDist / classifiedDist) * 100 : 0,
  };
}

export function refineMetricsWithTerrain(
  route: BrouterRoute,
  queryEle: (lng: number, lat: number) => number | null | undefined,
): RouteMetrics | null {
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

  return aggregate(rows, route.distanceM);
}