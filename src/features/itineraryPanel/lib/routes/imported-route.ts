import { routeLengthM } from '@/features/poi/lib/gpx-loader';
import { translateAppText } from '@/shared/i18n';

// Modules concrets, pas les barrels geocoding / route-metrics : ce module est
// sur le chargement initial du navigateur de projets (normalisation du projet),
// et les barrels y tiraient le géocodeur Mapbox et le client BRouter.
import { formatGpsCoordinateLabel } from '../geocoding/coordinateLabel';
import { cleanAndInterpolateElevations } from '../route-metrics/elevationSanitizer';
import { computeRouteElevationMetrics, computeRouteSurfaceMetricsFromPoints } from '../route-metrics/metrics';
import { extractRouteProfileFromPoints } from '../route-metrics/profile';
import type { RouteProfilePoint } from '../route-metrics/types';
import { sampleTerrainElevationsAtPoints } from '../route-metrics/terrainTiles';
import type { Itinerary, ItineraryMetrics, TimelineItem } from '../../types';

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
  profile: RouteProfilePoint[],
  sourcePoints?: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  return profile.map((point, index) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: point.distanceM,
    elevationM: point.elevationM,
    gradientPct: point.gradientPct,
    surface: point.surface ?? sourcePoints?.[index]?.surface,
  }));
}

function buildDistanceOnlyRoutePoints(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  let cumulativeDistanceM = 0;
  return points.map((point, index) => {
    if (index > 0) {
      if (
        typeof point.distanceM === 'number' &&
        Number.isFinite(point.distanceM) &&
        point.distanceM >= cumulativeDistanceM
      ) {
        cumulativeDistanceM = point.distanceM;
      } else {
        cumulativeDistanceM += haversineM(points[index - 1]!, point);
      }
    }
    return {
      lat: point.lat,
      lon: point.lon,
      distanceM: cumulativeDistanceM,
      elevationM: point.elevationM ?? null,
      surface: point.surface,
    };
  });
}

interface NormalizeImportedRoutePointsOptions {
  includeGradient?: boolean;
}

export async function refineImportedRoutePointsWithIgnAltimetry(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
  signal?: AbortSignal,
): Promise<NonNullable<Itinerary['gpxRoute']>['points'] | null> {
  if (points.length < 2) return null;

  const elevations = await sampleTerrainElevationsAtPoints(points, signal);
  let coverage = 0;
  const refined = points.map((point, index) => {
    const elevation = elevations[index];
    if (elevation != null && Number.isFinite(elevation)) {
      coverage += 1;
      return {
        ...point,
        elevationM: elevation,
      };
    }
    return point;
  });

  return coverage / points.length >= 0.6 ? cleanAndInterpolateElevations(refined) : null;
}

export function normalizeImportedRoutePoints(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
  options?: NormalizeImportedRoutePointsOptions,
): NonNullable<Itinerary['gpxRoute']>['points'] {
  const sanitizedPoints = cleanAndInterpolateElevations(points);

  if (options?.includeGradient === false) {
    return buildDistanceOnlyRoutePoints(sanitizedPoints);
  }

  const geometryOnlyPoints = sanitizedPoints.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: point.distanceM,
    elevationM: point.elevationM ?? null,
    surface: point.surface,
  }));
  const profile = extractRouteProfileFromPoints(geometryOnlyPoints);
  if (!profile || profile.length !== sanitizedPoints.length) {
    return buildDistanceOnlyRoutePoints(sanitizedPoints);
  }
  return toStoredRoutePoints(profile, sanitizedPoints);
}

export function buildImportedRouteMetrics(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): ItineraryMetrics {
  const sanitizedPoints = cleanAndInterpolateElevations(points);
  const elevationMetrics = computeRouteElevationMetrics(sanitizedPoints);
  const surfaceMetrics = computeRouteSurfaceMetricsFromPoints(sanitizedPoints);
  const lastPoint = sanitizedPoints[sanitizedPoints.length - 1];
  const distanceM =
    (typeof lastPoint?.distanceM === 'number' && lastPoint.distanceM > 0)
      ? lastPoint.distanceM
      : (elevationMetrics?.distanceM ?? routeLengthM(sanitizedPoints));
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
    tarmacPercent: surfaceMetrics ? Math.round(surfaceMetrics.tarmacPercent) : undefined,
    offroadPercent: surfaceMetrics ? Math.round(surfaceMetrics.offroadPercent) : undefined,
  };
}

function sampleImportedTimelineWaypoints(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): TimelineItem[] {
  if (points.length < 4) return [];

  const totalDistM = points[points.length - 1]?.distanceM ?? routeLengthM(points);
  const totalKm = totalDistM / 1000;

  // Pas de waypoints intermédiaires pour les tout petits parcours (< 5 km)
  if (totalKm < 5) return [];

  let targetCount = 0;
  if (totalKm < 15) {
    targetCount = 2;
  } else if (totalKm < 40) {
    targetCount = 3;
  } else if (totalKm < 80) {
    targetCount = 5;
  } else if (totalKm < 150) {
    targetCount = 8;
  } else if (totalKm < 250) {
    targetCount = 11;
  } else {
    // Grands tracés (ex: Corse ~350 km) : 12 à 16 points de passage espacés de ~20-25 km
    targetCount = Math.min(16, Math.max(12, Math.round(totalKm / 24)));
  }

  const targetIntervalM = totalDistM / (targetCount + 1);
  const minSpacingM = Math.max(1200, targetIntervalM * 0.45);
  const searchRadiusM = targetIntervalM * 0.35;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const calculateBearing = (
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
  ): number => {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };

  const bearingDiff = (b1: number, b2: number): number => {
    const diff = Math.abs(b1 - b2) % 360;
    return diff > 180 ? 360 - diff : diff;
  };

  const computeTurnAngleAt = (idx: number): number => {
    const currentDist = points[idx].distanceM ?? 0;
    let prevIdx = Math.max(0, idx - 1);
    while (prevIdx > 0 && currentDist - (points[prevIdx].distanceM ?? 0) < 50) {
      prevIdx -= 1;
    }
    let nextIdx = Math.min(points.length - 1, idx + 1);
    while (nextIdx < points.length - 1 && (points[nextIdx].distanceM ?? 0) - currentDist < 50) {
      nextIdx += 1;
    }
    const b1 = calculateBearing(points[prevIdx], points[idx]);
    const b2 = calculateBearing(points[idx], points[nextIdx]);
    return bearingDiff(b1, b2);
  };

  const waypoints: TimelineItem[] = [];
  let lastPickedDistM = 0;

  for (let k = 1; k <= targetCount; k += 1) {
    const idealDistM = k * targetIntervalM;
    const windowStartM = Math.max(lastPickedDistM + minSpacingM, idealDistM - searchRadiusM);
    const windowEndM = Math.min(totalDistM - minSpacingM, idealDistM + searchRadiusM);

    if (windowEndM <= windowStartM) continue;

    // Recherche binaire de l'indice de début dans la fenêtre
    let startIdx = 0;
    let endIdx = points.length - 1;
    while (startIdx < endIdx) {
      const mid = Math.floor((startIdx + endIdx) / 2);
      if ((points[mid].distanceM ?? 0) < windowStartM) {
        startIdx = mid + 1;
      } else {
        endIdx = mid;
      }
    }

    let bestPointIdx = -1;
    let bestScore = -Infinity;

    for (let i = startIdx; i < points.length - 1; i += 1) {
      const p = points[i];
      const distM = p.distanceM ?? 0;
      if (distM > windowEndM) break;

      const turnAngle = computeTurnAngleAt(i);
      const distPenalty = (Math.abs(distM - idealDistM) / targetIntervalM) * 1.5;
      const score = (turnAngle / 120) * 1.8 - distPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestPointIdx = i;
      }
    }

    if (bestPointIdx >= 0) {
      const bestPoint = points[bestPointIdx];
      const distM = bestPoint.distanceM ?? 0;
      if (distM - lastPickedDistM >= minSpacingM) {
        const wpIndex = waypoints.length + 1;
        const distKm = Math.round((distM / 1000) * 10) / 10;
        waypoints.push({
          id: `wp-import-${wpIndex}-${Math.round(bestPoint.lat * 10000)}`,
          kind: 'waypoint',
          label: `${translateAppText('Point de passage')} ${wpIndex}`,
          distanceKm: distKm,
          lat: bestPoint.lat,
          lon: bestPoint.lon,
          onRoute: true,
          visible: true,
        });
        lastPickedDistM = distM;
      }
    }
  }

  return waypoints;
}

/** Un point échantillonné à moins de ça d'un point du fichier fait doublon. */
const IMPORTED_WAYPOINT_DEDUPE_KM = 1;

/**
 * @param importedWaypoints points de passage lus dans le GPX (<wpt>), fusionnés
 *   avec l'échantillonnage automatique (qui cède la place à proximité).
 */
export function createImportedTimeline(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
  importedWaypoints: TimelineItem[] = [],
): Itinerary['timeline'] {
  const startPoint = points[0];
  const endPoint = points[points.length - 1] ?? startPoint;
  if (!startPoint || !endPoint) {
    return [
      { id: 'start', kind: 'start', label: translateAppText('Rechercher un lieu'), distanceKm: 0 },
      { id: 'end', kind: 'end', label: translateAppText('Rechercher un lieu'), distanceKm: null },
    ];
  }

  const sampledWaypoints = sampleImportedTimelineWaypoints(points);
  const waypoints = importedWaypoints.length === 0
    ? sampledWaypoints
    : [
      ...importedWaypoints,
      ...sampledWaypoints.filter((sampled) => !importedWaypoints.some((imported) => (
        sampled.distanceKm != null
        && imported.distanceKm != null
        && Math.abs(sampled.distanceKm - imported.distanceKm) < IMPORTED_WAYPOINT_DEDUPE_KM
      ))),
    ].sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

  return [
    {
      id: 'start',
      kind: 'start',
      label: formatGpsCoordinateLabel(startPoint.lon, startPoint.lat),
      distanceKm: 0,
      lat: startPoint.lat,
      lon: startPoint.lon,
    },
    ...waypoints,
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