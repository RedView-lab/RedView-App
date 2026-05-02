import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import { formatGpsCoordinateLabel } from '../geocoding';
import { computeRouteElevationMetrics, extractRouteProfileFromPoints } from '../route-metrics';
import type { Itinerary, ItineraryMetrics } from '../../types';

const EARTH_RADIUS_M = 6_371_008.8;

function haversineM(
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

function toStoredRoutePoints(
  profile: Array<{
    lat: number;
    lon: number;
    distanceM: number;
    elevationM: number;
    gradientPct: number;
  }>,
): NonNullable<Itinerary['gpxRoute']>['points'] {
  return profile.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: point.distanceM,
    elevationM: point.elevationM,
    gradientPct: point.gradientPct,
  }));
}

export function normalizeImportedRoutePoints(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  const geometryOnlyPoints = points.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    elevationM: point.elevationM ?? null,
  }));
  const profile = extractRouteProfileFromPoints(geometryOnlyPoints);
  if (!profile || profile.length !== points.length) {
    let cumulativeDistanceM = 0;
    return points.map((point, index) => ({
      ...point,
      ...(index > 0
        ? {
            distanceM: (() => {
              cumulativeDistanceM += haversineM(points[index - 1]!, point);
              return cumulativeDistanceM;
            })(),
          }
        : { distanceM: 0 }),
    }));
  }
  return toStoredRoutePoints(profile);
}

export function buildImportedRouteMetrics(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): ItineraryMetrics {
  const elevationMetrics = computeRouteElevationMetrics(points);
  const distanceM = elevationMetrics?.distanceM ?? routeLengthM(points);
  return {
    distanceKm: Math.round(distanceM / 100) / 10,
    ascentM: elevationMetrics
      ? Math.max(0, Math.round(elevationMetrics.ascentM))
      : undefined,
    descentM: elevationMetrics
      ? Math.max(0, Math.round(elevationMetrics.descentM))
      : undefined,
    avgSlopePercent: elevationMetrics
      ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
      : undefined,
  };
}

export function createImportedTimeline(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): Itinerary['timeline'] {
  const startPoint = points[0];
  const endPoint = points[points.length - 1] ?? startPoint;
  if (!startPoint || !endPoint) {
    return [
      { id: 'start', kind: 'start', label: 'Rechercher un lieu', distanceKm: 0 },
      { id: 'end', kind: 'end', label: 'Rechercher un lieu', distanceKm: null },
    ];
  }

  return [
    {
      id: 'start',
      kind: 'start',
      label: formatGpsCoordinateLabel(startPoint.lon, startPoint.lat),
      distanceKm: 0,
      lat: startPoint.lat,
      lon: startPoint.lon,
    },
    {
      id: 'end',
      kind: 'end',
      label: formatGpsCoordinateLabel(endPoint.lon, endPoint.lat),
      distanceKm:
        typeof endPoint.distanceM === 'number'
          ? Math.round((endPoint.distanceM / 1000) * 10) / 10
          : null,
      lat: endPoint.lat,
      lon: endPoint.lon,
    },
  ];
}