import type { PredictionResult } from '@/features/fitPredictor';
import { poiLabel } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import type { Itinerary, PoiCategory, TimelineItem } from '@/features/itineraryPanel/types';
import type { AxisMode } from '../series';

const EARTH_RADIUS_M = 6_371_008.8;
const normalizedRouteProfileCache = new WeakMap<RoutePoint[], ElevationSample[] | null>();
const predictionTimelineCache = new WeakMap<PredictionResult, TimelineSample[] | null>();
const predictionProfileCache = new WeakMap<PredictionResult, ElevationSample[] | null>();

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

export interface ChartPoiAnnotation {
  id: string;
  itineraryId: string;
  itineraryName: string;
  label: string;
  categoryLabel: string;
  poiCategory?: PoiCategory;
  x: number;
  y: number;
}

export function buildPoiAnnotationsForItinerary(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
): ChartPoiAnnotation[] {
  const poiRows = itinerary.timeline.filter(isVisiblePoiRow);
  if (poiRows.length === 0) return [];

  const profile =
    normalizeRouteProfile(itinerary.gpxRoute?.points ?? null) ??
    normalizePredictionProfile(prediction);
  if (!profile || profile.length < 2) return [];

  const timeline = xMode === 'distance' ? null : getPredictionTimeline(prediction);
  if (xMode !== 'distance' && (!timeline || timeline.length < 2)) return [];

  const result: ChartPoiAnnotation[] = [];
  for (const row of poiRows) {
    const distanceKm = row.distanceKm;
    if (!Number.isFinite(distanceKm)) continue;

    const distanceM = (distanceKm as number) * 1000;
    const x =
      xMode === 'distance'
        ? (distanceKm as number)
        : projectElapsedHoursToX(
            interpolateElapsedHoursFromTimeline(timeline, distanceM),
            xMode,
            itinerary.rhythm.startTime,
          );
    const y = interpolateElevation(profile, distanceM);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    result.push({
      id: `${itinerary.id}::poi::${row.id}`,
      itineraryId: itinerary.id,
      itineraryName: itinerary.name,
      label: row.label?.trim() || poiLabel(row.poiCategory ?? 'fountains'),
      categoryLabel: row.poiCategory ? poiLabel(row.poiCategory) : 'POI',
      poiCategory: row.poiCategory,
      x,
      y,
    });
  }

  return result;
}

function isVisiblePoiRow(row: TimelineItem): row is TimelineItem & { distanceKm: number } {
  return row.kind === 'poi' && row.visible !== false && Number.isFinite(row.distanceKm);
}

function normalizeRouteProfile(routePoints: RoutePoint[] | null | undefined): ElevationSample[] | null {
  if (!routePoints || routePoints.length < 2) return null;

  const cached = normalizedRouteProfileCache.get(routePoints);
  if (cached !== undefined) return cached;

  const samples: ElevationSample[] = [];
  let cumulativeDistanceM = 0;
  let previousLat = Number.NaN;
  let previousLon = Number.NaN;

  for (const point of routePoints) {
    const hasLatLon = Number.isFinite(point.lat) && Number.isFinite(point.lon);
    if (hasLatLon && Number.isFinite(previousLat) && Number.isFinite(previousLon)) {
      cumulativeDistanceM += haversineMeters(previousLat, previousLon, point.lat, point.lon);
    }

    if (hasLatLon) {
      previousLat = point.lat;
      previousLon = point.lon;
    }

    if (!Number.isFinite(point.elevationM)) continue;

    const explicitDistanceM = Number.isFinite(point.distanceM) ? (point.distanceM as number) : cumulativeDistanceM;
    samples.push({
      distanceM: explicitDistanceM,
      elevationM: point.elevationM as number,
    });
  }

  const result = dedupeElevationSamples(samples);
  normalizedRouteProfileCache.set(routePoints, result);
  return result;
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
      .filter(
        (point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elevationM),
      ),
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
    .filter(
      (point) => Number.isFinite(point.distanceM) && Number.isFinite(point.elapsedHours),
    );

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
  startTime?: string | null,
): number {
  if (!Number.isFinite(elapsedHours)) return Number.NaN;
  if (xMode !== 'heure') return elapsedHours as number;
  return (elapsedHours as number) + parseStartTimeHours(startTime);
}

function parseStartTimeHours(startTime?: string | null): number {
  if (!startTime) return 0;
  const [hoursRaw, minutesRaw] = startTime.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours + minutes / 60;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a =
    sinLat * sinLat +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
