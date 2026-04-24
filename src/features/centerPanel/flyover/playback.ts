import type { PredictionResult } from '@/features/fitPredictor';
import type { AxisMode, RouteChartPoint } from '../components/chart';

const EARTH_RADIUS_M = 6_371_008.8;

export interface RoutePlaybackGeometry {
  distancesM: number[];
  totalDistanceM: number;
}

export interface RoutePlaybackPoint extends RouteChartPoint {
  distanceM: number;
}

export interface CinematicCameraTarget {
  point: RoutePlaybackPoint;
  bearing: number | null;
  turnDeltaDeg: number;
  smoothedGradientPct: number;
  elevationDeltaM: number;
  elevationRangeM: number;
}

function haversineM(a: RouteChartPoint, b: RouteChartPoint): number {
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

export function distanceBetweenRoutePlaybackPointsM(
  left: RouteChartPoint | null | undefined,
  right: RouteChartPoint | null | undefined,
): number {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return haversineM(left, right);
}

export function buildRoutePlaybackGeometry(
  routePoints: RouteChartPoint[] | null | undefined,
): RoutePlaybackGeometry | null {
  if (!routePoints || routePoints.length < 2) return null;

  const distancesM: number[] = [0];
  let cumulativeDistanceM = 0;
  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index];
    const nextDistanceM = point.distanceM;
    if (Number.isFinite(nextDistanceM) && (nextDistanceM as number) >= cumulativeDistanceM) {
      cumulativeDistanceM = nextDistanceM as number;
    } else {
      cumulativeDistanceM += haversineM(routePoints[index - 1], point);
    }
    distancesM.push(cumulativeDistanceM);
  }

  return {
    distancesM,
    totalDistanceM: cumulativeDistanceM,
  };
}

export function clampDistanceM(distanceM: number, totalDistanceM: number): number {
  if (!Number.isFinite(distanceM)) return 0;
  return Math.max(0, Math.min(totalDistanceM, distanceM));
}

export function interpolateRoutePointAtDistance(
  routePoints: RouteChartPoint[] | null | undefined,
  geometry: RoutePlaybackGeometry | null,
  targetDistanceM: number,
): RoutePlaybackPoint | null {
  if (!routePoints || !geometry || routePoints.length === 0) return null;

  const clampedDistanceM = clampDistanceM(targetDistanceM, geometry.totalDistanceM);
  const distances = geometry.distancesM;
  if (clampedDistanceM <= distances[0]) {
    const point = routePoints[0];
    return point ? { ...point, distanceM: 0 } : null;
  }

  const lastIndex = routePoints.length - 1;
  if (clampedDistanceM >= distances[lastIndex]) {
    const point = routePoints[lastIndex];
    return point ? { ...point, distanceM: distances[lastIndex] ?? clampedDistanceM } : null;
  }

  let lo = 0;
  let hi = lastIndex;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((distances[mid] ?? 0) <= clampedDistanceM) lo = mid;
    else hi = mid;
  }

  const startPoint = routePoints[lo];
  const endPoint = routePoints[hi];
  const span = (distances[hi] ?? 0) - (distances[lo] ?? 0);
  if (span <= 0) return { ...startPoint, distanceM: clampedDistanceM };

  const t = Math.max(0, Math.min(1, (clampedDistanceM - (distances[lo] ?? 0)) / span));
  return {
    lat: startPoint.lat + (endPoint.lat - startPoint.lat) * t,
    lon: startPoint.lon + (endPoint.lon - startPoint.lon) * t,
    distanceM: clampedDistanceM,
    elevationM:
      Number.isFinite(startPoint.elevationM) && Number.isFinite(endPoint.elevationM)
        ? (startPoint.elevationM as number) + ((endPoint.elevationM as number) - (startPoint.elevationM as number)) * t
        : startPoint.elevationM ?? endPoint.elevationM ?? null,
    gradientPct:
      Number.isFinite(startPoint.gradientPct) && Number.isFinite(endPoint.gradientPct)
        ? (startPoint.gradientPct as number) + ((endPoint.gradientPct as number) - (startPoint.gradientPct as number)) * t
        : startPoint.gradientPct ?? endPoint.gradientPct ?? null,
  };
}

export function buildRouteTrailCoordinates(
  routePoints: RouteChartPoint[] | null | undefined,
  geometry: RoutePlaybackGeometry | null,
  targetDistanceM: number,
): [number, number][] {
  if (!routePoints || !geometry || routePoints.length === 0) return [];

  const clampedDistanceM = clampDistanceM(targetDistanceM, geometry.totalDistanceM);
  const trail: [number, number][] = [];
  for (let index = 0; index < routePoints.length; index += 1) {
    const point = routePoints[index];
    const pointDistanceM = geometry.distancesM[index] ?? 0;
    if (pointDistanceM > clampedDistanceM) break;
    trail.push([point.lon, point.lat]);
  }

  const interpolatedPoint = interpolateRoutePointAtDistance(routePoints, geometry, clampedDistanceM);
  if (!interpolatedPoint) return trail;

  const lastCoordinate = trail[trail.length - 1];
  const currentCoordinate: [number, number] = [interpolatedPoint.lon, interpolatedPoint.lat];
  if (
    !lastCoordinate ||
    Math.abs(lastCoordinate[0] - currentCoordinate[0]) > 1e-8 ||
    Math.abs(lastCoordinate[1] - currentCoordinate[1]) > 1e-8
  ) {
    trail.push(currentCoordinate);
  }

  return trail;
}

function bearingDegrees(from: RoutePlaybackPoint, to: RoutePlaybackPoint): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const toDeg = (radians: number) => (radians * 180) / Math.PI;
  const lon1 = toRad(from.lon);
  const lon2 = toRad(to.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function bearingAtDistance(
  routePoints: RouteChartPoint[] | null | undefined,
  geometry: RoutePlaybackGeometry | null,
  targetDistanceM: number,
  sampleSpanM = 180,
): number | null {
  if (!routePoints || !geometry) return null;
  const start = interpolateRoutePointAtDistance(routePoints, geometry, targetDistanceM);
  const end = interpolateRoutePointAtDistance(routePoints, geometry, targetDistanceM + sampleSpanM);
  if (!start || !end) return null;
  const deltaLon = Math.abs(end.lon - start.lon);
  const deltaLat = Math.abs(end.lat - start.lat);
  if (deltaLon < 1e-8 && deltaLat < 1e-8) return null;
  return bearingDegrees(start, end);
}

export function cinematicBearingAtDistance(
  routePoints: RouteChartPoint[] | null | undefined,
  geometry: RoutePlaybackGeometry | null,
  targetDistanceM: number,
): number | null {
  if (!routePoints || !geometry) return null;

  const samples = [
    { lookAheadM: 120, weight: 1.6 },
    { lookAheadM: 240, weight: 1.1 },
    { lookAheadM: 420, weight: 0.75 },
  ] as const;

  let sumX = 0;
  let sumY = 0;
  let totalWeight = 0;

  for (const sample of samples) {
    const bearing = bearingAtDistance(routePoints, geometry, targetDistanceM, sample.lookAheadM);
    if (!Number.isFinite(bearing)) continue;
    const radians = ((bearing as number) * Math.PI) / 180;
    sumX += Math.cos(radians) * sample.weight;
    sumY += Math.sin(radians) * sample.weight;
    totalWeight += sample.weight;
  }

  if (totalWeight <= 0 || (Math.abs(sumX) < 1e-6 && Math.abs(sumY) < 1e-6)) return null;
  return ((Math.atan2(sumY, sumX) * 180) / Math.PI + 360) % 360;
}

export function buildCinematicCameraTarget(
  routePoints: RouteChartPoint[] | null | undefined,
  geometry: RoutePlaybackGeometry | null,
  targetDistanceM: number,
): CinematicCameraTarget | null {
  if (!routePoints || !geometry) return null;

  const anchorSamples = [
    { offsetM: 0, weight: 1.0 },
    { offsetM: 70, weight: 1.2 },
    { offsetM: 160, weight: 1.15 },
    { offsetM: 280, weight: 0.85 },
    { offsetM: 430, weight: 0.55 },
  ] as const;

  let weightedLat = 0;
  let weightedLon = 0;
  let weightedElevation = 0;
  let totalWeight = 0;
  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;
  let firstElevationM: number | null = null;
  let farElevationM: number | null = null;
  let firstDistanceM: number | null = null;
  let farDistanceM: number | null = null;

  for (const sample of anchorSamples) {
    const sampleDistanceM = clampDistanceM(targetDistanceM + sample.offsetM, geometry.totalDistanceM);
    const point = interpolateRoutePointAtDistance(
      routePoints,
      geometry,
      sampleDistanceM,
    );
    if (!point) continue;
    const elevationM =
      robustGroundElevationAtDistance(routePoints, geometry, sampleDistanceM) ?? point.elevationM ?? 0;
    weightedLat += point.lat * sample.weight;
    weightedLon += point.lon * sample.weight;
    weightedElevation += elevationM * sample.weight;
    totalWeight += sample.weight;
    minElevationM = Math.min(minElevationM, elevationM);
    maxElevationM = Math.max(maxElevationM, elevationM);
    if (firstElevationM == null) {
      firstElevationM = elevationM;
      firstDistanceM = sampleDistanceM;
    }
    farElevationM = elevationM;
    farDistanceM = sampleDistanceM;
  }

  if (totalWeight <= 0) return null;

  const bearing = cinematicBearingAtDistance(routePoints, geometry, targetDistanceM);
  const nearBearing = bearingAtDistance(routePoints, geometry, targetDistanceM, 120);
  const farBearing = bearingAtDistance(routePoints, geometry, targetDistanceM + 120, 260);
  const signedTurnDeltaDeg =
    nearBearing != null && farBearing != null ? signedAngularDeltaDegrees(nearBearing, farBearing) : 0;
  const lateralOffsetM = clampMagnitude(Math.abs(signedTurnDeltaDeg) * 0.22, 0, 12);

  const averagedPoint: RoutePlaybackPoint = {
    lat: weightedLat / totalWeight,
    lon: weightedLon / totalWeight,
    distanceM: clampDistanceM(targetDistanceM, geometry.totalDistanceM),
    elevationM: weightedElevation / totalWeight,
    gradientPct:
      firstElevationM != null &&
      farElevationM != null &&
      firstDistanceM != null &&
      farDistanceM != null &&
      Math.abs(farDistanceM - firstDistanceM) > 1
        ? ((farElevationM - firstElevationM) / (farDistanceM - firstDistanceM)) * 100
        : 0,
  };

  const offsetPoint =
    bearing != null && lateralOffsetM > 0.25
      ? offsetPointByMeters(averagedPoint, bearing + (signedTurnDeltaDeg >= 0 ? 90 : -90), lateralOffsetM)
      : averagedPoint;

  return {
    point: offsetPoint,
    bearing,
    turnDeltaDeg: signedTurnDeltaDeg,
    smoothedGradientPct: averagedPoint.gradientPct ?? 0,
    elevationDeltaM:
      firstElevationM != null && farElevationM != null ? farElevationM - firstElevationM : 0,
    elevationRangeM:
      Number.isFinite(minElevationM) && Number.isFinite(maxElevationM) ? maxElevationM - minElevationM : 0,
  };
}

export function elapsedSecondsAtDistance(
  prediction: PredictionResult | null | undefined,
  distanceM: number,
  totalDistanceM: number,
): number | null {
  const points = prediction?.points ?? [];
  if (points.length >= 2) {
    if (distanceM <= points[0].distance_m) return points[0].elapsed_time_s;
    const lastPoint = points[points.length - 1];
    if (distanceM >= lastPoint.distance_m) return lastPoint.elapsed_time_s;

    let lo = 0;
    let hi = points.length - 1;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (points[mid].distance_m <= distanceM) lo = mid;
      else hi = mid;
    }

    const start = points[lo];
    const end = points[hi];
    const span = end.distance_m - start.distance_m;
    if (span <= 0) return start.elapsed_time_s;
    const t = (distanceM - start.distance_m) / span;
    return start.elapsed_time_s + (end.elapsed_time_s - start.elapsed_time_s) * t;
  }

  const totalTimeS = prediction?.total_time_s ?? null;
  if (!Number.isFinite(totalTimeS) || !Number.isFinite(totalDistanceM) || totalDistanceM <= 0) {
    return null;
  }
  return (clampDistanceM(distanceM, totalDistanceM) / totalDistanceM) * (totalTimeS as number);
}

function parseStartTimeHours(startTime?: string | null): number {
  if (!startTime) return 0;
  const [hoursRaw, minutesRaw] = startTime.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours + minutes / 60;
}

export function xValueFromDistance(
  distanceM: number,
  options: {
    prediction: PredictionResult | null | undefined;
    totalDistanceM: number;
    xMode: AxisMode;
    startTime?: string | null;
  },
): number {
  const clampedDistanceM = clampDistanceM(distanceM, options.totalDistanceM);
  if (options.xMode === 'distance') return clampedDistanceM / 1000;

  const elapsedSeconds = elapsedSecondsAtDistance(
    options.prediction,
    clampedDistanceM,
    options.totalDistanceM,
  );
  if (!Number.isFinite(elapsedSeconds)) return Number.NaN;

  const elapsedHours = (elapsedSeconds as number) / 3600;
  if (options.xMode === 'heure') return elapsedHours + parseStartTimeHours(options.startTime);
  return elapsedHours;
}

export function formatDistanceLabel(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(1)} km`;
}

export function formatPlaybackClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function offsetPointByMeters(
  point: RoutePlaybackPoint,
  bearingDeg: number,
  distanceM: number,
): RoutePlaybackPoint {
  const radians = (bearingDeg * Math.PI) / 180;
  const eastM = Math.sin(radians) * distanceM;
  const northM = Math.cos(radians) * distanceM;
  const latRadians = (point.lat * Math.PI) / 180;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = Math.max(1, 111_320 * Math.cos(latRadians));

  return {
    ...point,
    lat: point.lat + northM / metersPerDegreeLat,
    lon: point.lon + eastM / metersPerDegreeLon,
  };
}

function signedAngularDeltaDegrees(left: number, right: number): number {
  return ((right - left + 540) % 360) - 180;
}

function clampMagnitude(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function robustGroundElevationAtDistance(
  routePoints: RouteChartPoint[] | null | undefined,
  geometry: RoutePlaybackGeometry | null,
  targetDistanceM: number,
): number | null {
  if (!routePoints || !geometry) return null;

  const neighborhoodOffsetsM = [-45, -20, 0, 20, 45] as const;
  const elevations = neighborhoodOffsetsM
    .map((offsetM) =>
      interpolateRoutePointAtDistance(
        routePoints,
        geometry,
        clampDistanceM(targetDistanceM + offsetM, geometry.totalDistanceM),
      )?.elevationM,
    )
    .filter((value): value is number => Number.isFinite(value));

  if (elevations.length === 0) return null;
  elevations.sort((left, right) => left - right);

  // Surface LiDAR includes canopy/building spikes. Bias the camera toward
  // the lower third of the local neighborhood so it follows the ground
  // trend instead of the tops of trees.
  const quantileIndex = Math.max(0, Math.floor((elevations.length - 1) * 0.35));
  return elevations[quantileIndex] ?? elevations[0] ?? null;
}