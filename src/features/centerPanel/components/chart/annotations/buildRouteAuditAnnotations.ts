import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary, ItineraryRouteAuditFinding } from '@/features/itineraryPanel/types';
import type { AxisMode } from '../series';
import {
  getRoutePointDistances,
  normalizeRouteProfile as normalizeChartRouteProfile,
} from '../series/routeProfile';

const EARTH_RADIUS_M = 6_371_008.8;
const predictionTimelineCache = new WeakMap<PredictionResult, TimelineSample[] | null>();
const predictionProfileCache = new WeakMap<PredictionResult, ElevationSample[] | null>();
const routeIndexByCoordCache = new WeakMap<RoutePoint[], Map<string, number>>();

interface RoutePoint {
  lat: number;
  lon: number;
  distanceM?: number;
  elevationM?: number | null;
}

interface ElevationSample {
  distanceM: number;
  elevationM: number;
}

interface TimelineSample {
  distanceM: number;
  elapsedHours: number;
}

export interface ChartAlertAnnotation {
  id: string;
  itineraryId: string;
  itineraryName: string;
  label: string;
  detail: string;
  x: number;
  y: number;
}

export function buildRouteAuditAnnotationsForItinerary(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
): ChartAlertAnnotation[] {
  const findings = itinerary.routeAudit?.findings ?? [];
  if (findings.length === 0) return [];

  const routePoints = itinerary.gpxRoute?.points ?? null;
  if (!routePoints || routePoints.length < 2) return [];

  const profile = normalizeChartRouteProfile(routePoints) ?? normalizePredictionProfile(prediction);
  if (!profile || profile.length < 2) return [];

  const timeline = xMode === 'distance' ? null : getPredictionTimeline(prediction);
  if (xMode !== 'distance' && (!timeline || timeline.length < 2)) return [];

  const routeIndexByCoord = getRouteIndexByCoord(routePoints);
  const routePointDistances = getRoutePointDistances(routePoints);

  const result: ChartAlertAnnotation[] = [];
  for (const finding of findings) {
    const distanceM = distanceForFinding(finding, routePointDistances, routeIndexByCoord);
    if (!Number.isFinite(distanceM)) continue;

    const x =
      xMode === 'distance'
        ? distanceM / 1000
        : projectElapsedHoursToX(
            interpolateElapsedHoursFromTimeline(timeline, distanceM),
            xMode,
            itinerary.rhythm.startTime,
          );
    const y = interpolateElevation(profile, distanceM);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    result.push({
      id: `${itinerary.id}::alert::${finding.id}`,
      itineraryId: itinerary.id,
      itineraryName: itinerary.name,
      label: finding.title,
      detail: finding.detail,
      x,
      y,
    });
  }

  return result;
}

function distanceForFinding(
  finding: ItineraryRouteAuditFinding,
  routePointDistances: number[],
  routeIndexByCoord: Map<string, number>,
): number {
  const coordinates = finding.coordinates;
  if (coordinates.length === 0) return Number.NaN;

  const firstIndex = routeIndexByCoord.get(coordKey(coordinates[0][0], coordinates[0][1]));
  const lastCoord = coordinates[coordinates.length - 1];
  const lastIndex = routeIndexByCoord.get(coordKey(lastCoord[0], lastCoord[1]));

  if (Number.isFinite(firstIndex) && Number.isFinite(lastIndex)) {
    const startDistance = distanceAtRouteIndex(routePointDistances, firstIndex as number);
    const endDistance = distanceAtRouteIndex(routePointDistances, lastIndex as number);
    if (Number.isFinite(startDistance) && Number.isFinite(endDistance)) {
      return (startDistance + endDistance) / 2;
    }
  }

  let distanceAlongFinding = 0;
  for (let index = 1; index < coordinates.length; index++) {
    distanceAlongFinding += haversineMeters(
      coordinates[index - 1][1],
      coordinates[index - 1][0],
      coordinates[index][1],
      coordinates[index][0],
    );
  }
  if (Number.isFinite(firstIndex)) {
    const startDistance = distanceAtRouteIndex(routePointDistances, firstIndex as number);
    return startDistance + distanceAlongFinding / 2;
  }
  return Number.NaN;
}

function distanceAtRouteIndex(routePointDistances: number[], index: number): number {
  return routePointDistances[index] ?? Number.NaN;
}

function coordKey(lon: number, lat: number): string {
  return `${lon.toFixed(6)}:${lat.toFixed(6)}`;
}

function getRouteIndexByCoord(routePoints: RoutePoint[]): Map<string, number> {
  const cached = routeIndexByCoordCache.get(routePoints);
  if (cached) return cached;

  const indexByCoord = new Map<string, number>();
  routePoints.forEach((point, index) => {
    indexByCoord.set(coordKey(point.lon, point.lat), index);
  });
  routeIndexByCoordCache.set(routePoints, indexByCoord);
  return indexByCoord;
}

function normalizePredictionProfile(
  prediction: PredictionResult | null | undefined,
): ElevationSample[] | null {
  if (!prediction || prediction.points.length < 2) return null;

  const cached = predictionProfileCache.get(prediction);
  if (cached !== undefined) return cached;

  const result = dedupeElevationSamples(
    prediction.points
      .map((point) => ({
        distanceM: point.distance_m,
        elevationM: point.elevation_m,
      }))
      .filter((point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elevationM)),
  );

  predictionProfileCache.set(prediction, result);
  return result;
}

function dedupeElevationSamples(samples: ElevationSample[]): ElevationSample[] | null {
  if (samples.length < 2) return null;

  samples.sort((left, right) => left.distanceM - right.distanceM);
  const deduped: ElevationSample[] = [];
  for (const sample of samples) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.distanceM - sample.distanceM) < 1e-6) {
      deduped[deduped.length - 1] = sample;
      continue;
    }
    deduped.push(sample);
  }

  return deduped.length >= 2 ? deduped : null;
}

function getPredictionTimeline(
  prediction: PredictionResult | null | undefined,
): TimelineSample[] | null {
  if (!prediction || prediction.points.length < 2) return null;

  const cached = predictionTimelineCache.get(prediction);
  if (cached !== undefined) return cached;

  const timeline = prediction.points
    .map((point) => ({
      distanceM: point.distance_m,
      elapsedHours: point.elapsed_time_s / 3600,
    }))
    .filter((point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elapsedHours));

  const result = timeline.length >= 2 ? timeline : null;
  predictionTimelineCache.set(prediction, result);
  return result;
}

function interpolateElapsedHoursFromTimeline(
  timeline: TimelineSample[] | null,
  distanceM: number,
): number | null {
  if (!timeline || timeline.length < 2) return null;
  if (distanceM <= timeline[0].distanceM) return timeline[0].elapsedHours;

  const last = timeline[timeline.length - 1];
  if (distanceM >= last.distanceM) return last.elapsedHours;

  let lo = 0;
  let hi = timeline.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timeline[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = timeline[lo];
  const end = timeline[hi];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) return start.elapsedHours;
  const t = (distanceM - start.distanceM) / spanM;
  return start.elapsedHours + (end.elapsedHours - start.elapsedHours) * t;
}

function interpolateElevation(profile: ElevationSample[], distanceM: number): number {
  if (profile.length === 0) return Number.NaN;
  if (distanceM <= profile[0].distanceM) return profile[0].elevationM;

  const last = profile[profile.length - 1];
  if (distanceM >= last.distanceM) return last.elevationM;

  let lo = 0;
  let hi = profile.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (profile[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = profile[lo];
  const end = profile[hi];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) return start.elevationM;
  const t = (distanceM - start.distanceM) / spanM;
  return start.elevationM + (end.elevationM - start.elevationM) * t;
}

function projectElapsedHoursToX(
  elapsedHours: number | null,
  xMode: AxisMode,
  startTime: string | null | undefined,
): number {
  if (!Number.isFinite(elapsedHours)) return Number.NaN;
  if (xMode === 'temps') return elapsedHours as number;
  if (xMode === 'heure') {
    const hoursOffset = parseStartTimeHours(startTime);
    return ((elapsedHours as number) + hoursOffset) % 24;
  }
  return Number.NaN;
}

function parseStartTimeHours(startTime: string | null | undefined): number {
  if (!startTime) return 0;
  const match = /^(\d{1,2}):(\d{2})/.exec(startTime.trim());
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours + minutes / 60;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a =
    sinLat * sinLat +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
