import type { PredictionConfig } from '@/features/fitPredictor';

import type { Itinerary, ItineraryProject, RhythmState } from '../../types';

const EARTH_RADIUS_M = 6_371_008.8;
const PREDICTION_TARGET_POINT_SPACING_M = 250;
const PREDICTION_MIN_ROUTE_POINTS = 4_000;
const PREDICTION_MAX_ROUTE_POINTS = 8_000;
type PredictionRoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];
type PredictionRoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

export function buildPredictionConfigFromRhythm(
  rhythm: RhythmState,
  routePoints?: PredictionRoutePoints | null,
): PredictionConfig {
  const config: PredictionConfig = {
    pacing_factor: 1,
  };

  const maxRoutePoints = resolvePredictionMaxRoutePoints(routePoints);
  if (maxRoutePoints != null) {
    config.max_route_points = maxRoutePoints;
  }

  if (rhythm.gender && rhythm.gender !== 'default') {
    config.gender = rhythm.gender;
  }

  if (typeof rhythm.ftp === 'number' && rhythm.ftp > 0) {
    config.ftp_w = rhythm.ftp;
  }

  if (
    typeof rhythm.systemWeightKg === 'number' &&
    rhythm.systemWeightKg > 0
  ) {
    config.mass_kg = rhythm.systemWeightKg;
  }

  if (rhythm.startTime) {
    const startTimeH = parseTimeToHourDecimal(rhythm.startTime);
    if (startTimeH !== null) {
      config.start_time_h = startTimeH;
    }
  }

  return config;
}

export function buildRouteGpxFile(
  itinerary: ItineraryProject['itineraries'][number],
): File {
  const routeName = escapeXml(itinerary.gpxRoute?.name ?? itinerary.name);
  const points = itinerary.gpxRoute?.points ?? [];
  const trackPoints = points
    .map((point) => {
      const ele = Number.isFinite(point.elevationM as number)
        ? (point.elevationM as number)
        : null;
      if (ele === null) {
        return `      <trkpt lat="${point.lat}" lon="${point.lon}"></trkpt>`;
      }
      return `      <trkpt lat="${point.lat}" lon="${point.lon}"><ele>${ele.toFixed(2)}</ele></trkpt>`;
    })
    .join('\n');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RedView" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    `    <name>${routeName}</name>`,
    '    <trkseg>',
    trackPoints,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ].join('\n');

  return new File([xml], `${slugifyFilename(itinerary.name || 'itinerary')}.gpx`, {
    type: 'application/gpx+xml',
  });
}

export function hasUsableRouteElevation(
  points: NonNullable<Itinerary['gpxRoute']>['points'] | null | undefined,
): boolean {
  if (!points) return false;
  let count = 0;
  for (const point of points) {
    if (Number.isFinite(point.elevationM)) count++;
    if (count >= 2) return true;
  }
  return false;
}

function parseTimeToHourDecimal(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours >= 24 ||
    minutes < 0 ||
    minutes >= 60
  ) {
    return null;
  }
  return hours + minutes / 60;
}

function resolvePredictionMaxRoutePoints(
  routePoints?: PredictionRoutePoints | null,
): number | undefined {
  const totalDistanceM = estimateRouteDistanceM(routePoints);
  if (!(totalDistanceM > 0)) return undefined;

  const estimatedCount = Math.ceil(totalDistanceM / PREDICTION_TARGET_POINT_SPACING_M);
  return Math.max(
    PREDICTION_MIN_ROUTE_POINTS,
    Math.min(PREDICTION_MAX_ROUTE_POINTS, estimatedCount),
  );
}

function estimateRouteDistanceM(
  routePoints?: PredictionRoutePoints | null,
): number {
  if (!routePoints || routePoints.length < 2) return 0;

  const lastDistanceM = routePoints[routePoints.length - 1]?.distanceM;
  if (Number.isFinite(lastDistanceM) && (lastDistanceM as number) > 0) {
    return lastDistanceM as number;
  }

  let totalDistanceM = 0;
  for (let index = 1; index < routePoints.length; index += 1) {
    totalDistanceM += haversineM(routePoints[index - 1], routePoints[index]);
  }
  return totalDistanceM;
}

function haversineM(
  start: Pick<PredictionRoutePoint, 'lat' | 'lon'>,
  end: Pick<PredictionRoutePoint, 'lat' | 'lon'>,
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(end.lat - start.lat);
  const dLon = toRad(end.lon - start.lon);
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function slugifyFilename(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '') || 'itinerary';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}