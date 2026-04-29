import type { ElevationSample, RoutePointInput, RouteProfilePoint } from './types';

const EARTH_RADIUS_M = 6_371_008.8;
const GRADIENT_SEGMENT_M = 30;

export function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function buildCumulativeDistances(points: RoutePointInput[]): number[] {
  const distances = new Array<number>(points.length).fill(0);

  for (let i = 1; i < points.length; i++) {
    const nextDistance = points[i].distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= distances[i - 1]) {
      distances[i] = nextDistance as number;
      continue;
    }

    distances[i] = distances[i - 1] + haversineM(points[i - 1], points[i]);
  }

  return distances;
}

export function buildElevationSamplesFromPoints(
  points: RoutePointInput[],
): { samples: ElevationSample[]; totalDistanceM: number } {
  if (points.length === 0) {
    return { samples: [], totalDistanceM: 0 };
  }

  const cumulativeDistances = buildCumulativeDistances(points);
  const samples: ElevationSample[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const elevationM = Number(point.elevationM);
    if (!Number.isFinite(elevationM)) continue;
    samples.push({
      lat: point.lat,
      lon: point.lon,
      ele: elevationM,
      distanceM: cumulativeDistances[i],
      gradientPct: point.gradientPct,
    });
  }

  return {
    samples,
    totalDistanceM: cumulativeDistances[cumulativeDistances.length - 1] ?? 0,
  };
}

export function smoothElevationValues(values: number[], windowSize = 5): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

function gradientWindowIndices(
  distances: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): { startIndex: number; endIndex: number } {
  const lastIndex = distances.length - 1;
  if (index <= 0) {
    let endIndex = 0;
    while (endIndex < lastIndex && distances[endIndex] - distances[0] < targetSpanM) {
      endIndex += 1;
    }
    return { startIndex: 0, endIndex };
  }

  if (index >= lastIndex) {
    let startIndex = lastIndex;
    while (startIndex > 0 && distances[lastIndex] - distances[startIndex] < targetSpanM) {
      startIndex -= 1;
    }
    return { startIndex, endIndex: lastIndex };
  }

  const minDistance = distances[0];
  const maxDistance = distances[lastIndex];
  const centerDistance = distances[index];
  const halfSpanM = targetSpanM / 2;
  let startTarget = centerDistance - halfSpanM;
  let endTarget = centerDistance + halfSpanM;

  if (startTarget < minDistance) {
    endTarget = Math.min(maxDistance, endTarget + (minDistance - startTarget));
    startTarget = minDistance;
  }
  if (endTarget > maxDistance) {
    startTarget = Math.max(minDistance, startTarget - (endTarget - maxDistance));
    endTarget = maxDistance;
  }

  let startIndex = index;
  while (startIndex > 0 && distances[startIndex] > startTarget) startIndex -= 1;

  let endIndex = index;
  while (endIndex < lastIndex && distances[endIndex] < endTarget) endIndex += 1;

  while (endIndex < lastIndex && distances[endIndex] - distances[startIndex] < targetSpanM) {
    endIndex += 1;
  }
  while (startIndex > 0 && distances[endIndex] - distances[startIndex] < targetSpanM) {
    startIndex -= 1;
  }

  return { startIndex, endIndex };
}

export function computeGradientPercentAtIndex(
  distances: number[],
  elevations: number[],
  index: number,
  targetSpanM = GRADIENT_SEGMENT_M,
): number {
  const { startIndex, endIndex } = gradientWindowIndices(distances, index, targetSpanM);
  const spanM = distances[endIndex] - distances[startIndex];
  if (spanM <= 0.5) return 0;
  return ((elevations[endIndex] - elevations[startIndex]) / spanM) * 100;
}

export function computeAscentDescentFromElevations(
  elevations: number[],
  thresholdM = 1,
): { ascent: number; descent: number } {
  if (elevations.length < 2) return { ascent: 0, descent: 0 };
  let ascent = 0;
  let descent = 0;
  let pivot = elevations[0];
  for (let i = 1; i < elevations.length; i++) {
    const delta = elevations[i] - pivot;
    if (Math.abs(delta) < thresholdM) continue;
    if (delta > 0) ascent += delta;
    else descent += -delta;
    pivot = elevations[i];
  }
  return { ascent, descent };
}

export function interpolateMissingElevations(elevations: Array<number | null>): number[] | null {
  const knownIndices = elevations.flatMap((value, index) =>
    value != null && Number.isFinite(value) ? [index] : [],
  );
  if (knownIndices.length < 2) return null;

  const filled = elevations.slice();
  const firstKnown = knownIndices[0];
  const lastKnown = knownIndices[knownIndices.length - 1];

  for (let i = 0; i < firstKnown; i++) {
    filled[i] = filled[firstKnown];
  }
  for (let i = lastKnown + 1; i < filled.length; i++) {
    filled[i] = filled[lastKnown];
  }

  for (let i = 0; i < knownIndices.length - 1; i++) {
    const startIndex = knownIndices[i];
    const endIndex = knownIndices[i + 1];
    const startValue = filled[startIndex] as number;
    const endValue = filled[endIndex] as number;
    const span = endIndex - startIndex;
    for (let j = startIndex + 1; j < endIndex; j++) {
      const t = (j - startIndex) / span;
      filled[j] = startValue + (endValue - startValue) * t;
    }
  }

  if (filled.some((value) => value == null || !Number.isFinite(value))) {
    return null;
  }
  return filled as number[];
}

export function smoothElevations(
  rows: Array<{ ele: number }>,
  windowSize = 5,
): number[] {
  return smoothElevationValues(
    rows.map((row) => row.ele),
    windowSize,
  );
}

export function computeAscentDescent(
  elevations: number[],
  thresholdM = 1,
): { ascent: number; descent: number } {
  return computeAscentDescentFromElevations(elevations, thresholdM);
}

export function buildRouteProfileFromSamples(samples: ElevationSample[]): RouteProfilePoint[] {
  const gradientBase = smoothElevationValues(
    samples.map((sample) => sample.ele),
    3,
  );
  const distances = samples.map((sample) => sample.distanceM);

  return samples.map((sample, index) => ({
    lat: sample.lat,
    lon: sample.lon,
    distanceM: sample.distanceM,
    elevationM: sample.ele,
    gradientPct: computeGradientPercentAtIndex(distances, gradientBase, index),
  }));
}