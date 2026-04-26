import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor/types';
import { cumulativeRouteLengthsM, projectDistanceAlongRouteM } from '@/features/itineraryPanel/lib/route-distance';
import { kindLabel, poiLabel } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import type { Itinerary, PauseIntervalRow, PoiCategory, TimelineItem } from '@/features/itineraryPanel/types';

import { formatDuration } from './format';
import type { CheckpointSeed, RouteSample, ServiceFlags, ServiceGapSummary, ScheduledCheckpoint, StopSource } from './types';

const WATER_CATEGORIES = new Set<PoiCategory>([
  'fountains',
  'supermarkets',
  'gasStations',
  'bakeries',
  'cafes',
  'bars',
  'restaurants',
  'hotels',
  'refuges',
]);

const FOOD_CATEGORIES = new Set<PoiCategory>([
  'supermarkets',
  'gasStations',
  'bakeries',
  'fastFood',
  'cafes',
  'bars',
  'restaurants',
  'hotels',
  'refuges',
]);

const SLEEP_CATEGORIES = new Set<PoiCategory>(['hotels', 'refuges']);
const MECHANIC_CATEGORIES = new Set<PoiCategory>(['bikeShops', 'gasStations']);

export function collectRouteSamples(itinerary: Itinerary): RouteSample[] {
  const points = itinerary.gpxRoute?.points;
  if (!points || points.length < 2) {
    throw new Error('La feuille de route Excel nécessite une trace active exploitable.');
  }

  const cumulativeLengths = cumulativeRouteLengthsM(points);
  return points.map((point, index) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM:
      Number.isFinite(point.distanceM) && (point.distanceM as number) >= 0
        ? (point.distanceM as number)
        : cumulativeLengths[index] ?? 0,
    elevationM: Number.isFinite(point.elevationM) ? (point.elevationM as number) : null,
  }));
}

export function collectTimelineCheckpoints(
  itinerary: Itinerary,
  route: RouteSample[],
): CheckpointSeed[] {
  const routePoints = route.map((point) => ({ lat: point.lat, lon: point.lon }));
  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);
  const totalDistanceM = route[route.length - 1]?.distanceM ?? 0;
  const checkpoints: CheckpointSeed[] = [];

  for (let index = 0; index < itinerary.timeline.length; index += 1) {
    const item = itinerary.timeline[index]!;
    if (!isRoadbookTimelineItem(item)) continue;
    const sampled = resolveItemSample(item, route, routePoints, cumulativeLengths, totalDistanceM);
    if (!sampled) continue;

    checkpoints.push({
      id: item.id,
      label: item.label.trim() || defaultLabelForItem(item),
      kind: item.kind,
      typeLabel: kindLabel(item.kind, item.poiCategory),
      distanceM: sampled.distanceM,
      lat: sampled.lat,
      lon: sampled.lon,
      elevationM: sampled.elevationM,
      poiCategory: item.poiCategory,
      stopMinutes: plannedStopMinutesForItem(itinerary, item),
      stopSource: stopSourceForItem(itinerary, item),
      generated: false,
      sortIndex: index,
    });
  }

  return checkpoints;
}

export function collectIntervalPauseCheckpoints(
  itinerary: Itinerary,
  route: RouteSample[],
  prediction: PredictionResult | null,
): CheckpointSeed[] {
  if (!itinerary.rhythm.pauseEveryIntervalEnabled || !prediction || prediction.points.length < 2) {
    return [];
  }

  const checkpoints: CheckpointSeed[] = [];
  const totalRideSeconds = prediction.riding_time_s;
  let sequence = 10_000;

  for (const intervalRow of itinerary.rhythm.pauseIntervals) {
    const stops = buildIntervalStopTimes(intervalRow, totalRideSeconds);
    for (let index = 0; index < stops.length; index += 1) {
      const elapsedSeconds = stops[index]!;
      const distanceM = distanceAtElapsedSeconds(prediction, elapsedSeconds);
      if (!Number.isFinite(distanceM)) continue;
      const sample = sampleRouteAtDistance(route, distanceM as number);
      checkpoints.push({
        id: `${intervalRow.id}::${index}`,
        label: `${intervalRow.label || 'Pause'} ${index + 1}`,
        kind: 'intervalPause',
        typeLabel: 'Pause intervalle',
        distanceM: distanceM as number,
        lat: sample.lat,
        lon: sample.lon,
        elevationM: sample.elevationM,
        stopMinutes: Math.max(0, intervalRow.durationMin),
        stopSource: 'interval',
        generated: true,
        sortIndex: sequence,
      });
      sequence += 1;
    }
  }

  return checkpoints;
}

export function classifyServices(checkpoint: CheckpointSeed): ServiceFlags {
  const category = checkpoint.poiCategory;
  return {
    water: category != null && WATER_CATEGORIES.has(category),
    food: category != null && FOOD_CATEGORIES.has(category),
    sleep: category != null && SLEEP_CATEGORIES.has(category),
    mechanic: category != null && MECHANIC_CATEGORIES.has(category),
  };
}

export function buildServiceTagLabel(checkpoint: CheckpointSeed): string {
  const tags: string[] = [];
  const services = classifyServices(checkpoint);
  if (checkpoint.kind === 'waypoint') tags.push('Contrôle');
  if (checkpoint.kind === 'pause' || checkpoint.kind === 'intervalPause') tags.push('Pause');
  if (services.water) tags.push('Eau');
  if (services.food) tags.push('Food');
  if (services.sleep) tags.push('Sommeil');
  if (services.mechanic) tags.push('Méca');
  if (checkpoint.stopMinutes >= 120 && !tags.includes('Sommeil')) tags.push('Sommeil');
  return tags.join(' · ');
}

export function summarizeServiceWindows(
  schedule: ScheduledCheckpoint[],
  service: keyof ServiceFlags,
): ServiceGapSummary {
  const markers = schedule.filter((checkpoint) => checkpoint.serviceFlags[service]);
  let longestDistanceM = 0;
  let longestRideSeconds: number | null = null;
  let fromLabel = schedule[0]?.label ?? '--';
  let toLabel = schedule[schedule.length - 1]?.label ?? '--';

  let previous = schedule[0] ?? null;
  for (const marker of markers) {
    if (!previous) {
      previous = marker;
      continue;
    }
    const gapDistanceM = Math.max(0, marker.distanceM - previous.distanceM);
    const gapRideSeconds =
      Number.isFinite(marker.cumulativeRideSeconds) && Number.isFinite(previous.cumulativeRideSeconds)
        ? (marker.cumulativeRideSeconds as number) - (previous.cumulativeRideSeconds as number)
        : null;
    if (gapDistanceM > longestDistanceM) {
      longestDistanceM = gapDistanceM;
      longestRideSeconds = gapRideSeconds;
      fromLabel = previous.label;
      toLabel = marker.label;
    }
    previous = marker;
  }

  const lastMarker = markers[markers.length - 1] ?? schedule[0] ?? null;
  const finish = schedule[schedule.length - 1] ?? null;
  if (lastMarker && finish) {
    const finalGapM = Math.max(0, finish.distanceM - lastMarker.distanceM);
    const finalRideSeconds =
      Number.isFinite(finish.cumulativeRideSeconds) && Number.isFinite(lastMarker.cumulativeRideSeconds)
        ? (finish.cumulativeRideSeconds as number) - (lastMarker.cumulativeRideSeconds as number)
        : null;
    if (finalGapM > longestDistanceM) {
      longestDistanceM = finalGapM;
      longestRideSeconds = finalRideSeconds;
      fromLabel = lastMarker.label;
      toLabel = finish.label;
    }
  }

  return {
    count: markers.length,
    longestDistanceKm: longestDistanceM / 1000,
    longestRideLabel: formatDuration(longestRideSeconds),
    fromLabel,
    toLabel,
  };
}

export function formatGapSummary(summary: ServiceGapSummary): string {
  if (summary.count === 0 || summary.longestDistanceKm <= 0) return '--';
  return `${summary.longestDistanceKm.toFixed(1)} km (${summary.longestRideLabel}) • ${summary.fromLabel} → ${summary.toLabel}`;
}

export function distanceSincePreviousService(
  schedule: ScheduledCheckpoint[],
  index: number,
  service: keyof ServiceFlags,
): number | null {
  const current = schedule[index];
  if (!current?.serviceFlags[service]) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!schedule[cursor]!.serviceFlags[service]) continue;
    return current.distanceM - schedule[cursor]!.distanceM;
  }
  return current.distanceM;
}

export function distanceToNextService(
  schedule: ScheduledCheckpoint[],
  index: number,
  service: keyof ServiceFlags,
): number | null {
  const current = schedule[index];
  if (!current?.serviceFlags[service]) return null;
  for (let cursor = index + 1; cursor < schedule.length; cursor += 1) {
    if (!schedule[cursor]!.serviceFlags[service]) continue;
    return schedule[cursor]!.distanceM - current.distanceM;
  }
  return null;
}

export function compareCheckpointSeeds(left: CheckpointSeed, right: CheckpointSeed): number {
  const distanceDelta = left.distanceM - right.distanceM;
  if (Math.abs(distanceDelta) > 0.01) return distanceDelta;

  const kindRankDelta = rankCheckpoint(left) - rankCheckpoint(right);
  if (kindRankDelta !== 0) return kindRankDelta;
  return left.sortIndex - right.sortIndex;
}

export function sampleRouteAtDistance(route: RouteSample[], distanceM: number): RouteSample {
  if (distanceM <= route[0]!.distanceM) return route[0]!;
  const last = route[route.length - 1]!;
  if (distanceM >= last.distanceM) return last;

  let lo = 0;
  let hi = route.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (route[mid]!.distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = route[lo]!;
  const end = route[hi]!;
  const span = end.distanceM - start.distanceM;
  if (span <= 0) return start;
  const t = (distanceM - start.distanceM) / span;
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lon: start.lon + (end.lon - start.lon) * t,
    distanceM,
    elevationM:
      start.elevationM != null && end.elevationM != null
        ? start.elevationM + (end.elevationM - start.elevationM) * t
        : start.elevationM ?? end.elevationM ?? null,
  };
}

function resolveItemSample(
  item: TimelineItem,
  route: RouteSample[],
  routePoints: Array<{ lat: number; lon: number }>,
  cumulativeLengths: number[],
  totalDistanceM: number,
): RouteSample | null {
  let distanceM: number | null = Number.isFinite(item.distanceKm) ? (item.distanceKm as number) * 1000 : null;
  if (distanceM == null && Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
    distanceM = projectDistanceAlongRouteM(
      { lat: item.lat as number, lon: item.lon as number },
      routePoints,
      cumulativeLengths,
    );
  }
  if (item.kind === 'start') distanceM = 0;
  if (item.kind === 'end') distanceM = totalDistanceM;
  if (!Number.isFinite(distanceM)) return null;

  const sampled = sampleRouteAtDistance(route, Math.max(0, Math.min(totalDistanceM, distanceM as number)));
  return {
    ...sampled,
    lat: Number.isFinite(item.lat) ? (item.lat as number) : sampled.lat,
    lon: Number.isFinite(item.lon) ? (item.lon as number) : sampled.lon,
  };
}

function plannedStopMinutesForItem(itinerary: Itinerary, item: TimelineItem): number {
  if (item.kind === 'pause') return Math.max(0, item.durationMin ?? 0);
  if (
    item.kind === 'poi'
    && item.favorite
    && itinerary.rhythm.pauseAtFavoritePois
    && item.poiCategory
  ) {
    return Math.max(0, itinerary.rhythm.poiPauseDurations[item.poiCategory] ?? 0);
  }
  return 0;
}

function stopSourceForItem(itinerary: Itinerary, item: TimelineItem): StopSource | undefined {
  if (item.kind === 'pause' && (item.durationMin ?? 0) > 0) return 'timeline-pause';
  if (
    item.kind === 'poi'
    && item.favorite
    && itinerary.rhythm.pauseAtFavoritePois
    && item.poiCategory
    && (itinerary.rhythm.poiPauseDurations[item.poiCategory] ?? 0) > 0
  ) {
    return 'favorite-poi';
  }
  return undefined;
}

function isRoadbookTimelineItem(item: TimelineItem): boolean {
  if (item.visible === false && item.kind !== 'start' && item.kind !== 'end') return false;
  return item.kind === 'start'
    || item.kind === 'end'
    || item.kind === 'waypoint'
    || item.kind === 'poi'
    || item.kind === 'pause';
}

function defaultLabelForItem(item: TimelineItem): string {
  if (item.kind === 'poi' && item.poiCategory) return poiLabel(item.poiCategory);
  return kindLabel(item.kind, item.poiCategory);
}

function buildIntervalStopTimes(intervalRow: PauseIntervalRow, totalRideSeconds: number): number[] {
  const intervalSeconds = Math.max(0, intervalRow.intervalMin) * 60;
  if (intervalSeconds <= 0) return [];
  const stops: number[] = [];
  for (let elapsedSeconds = intervalSeconds; elapsedSeconds < totalRideSeconds; elapsedSeconds += intervalSeconds) {
    stops.push(elapsedSeconds);
  }
  return stops;
}

function distanceAtElapsedSeconds(
  prediction: PredictionResult,
  elapsedSeconds: number,
): number | null {
  const points = prediction.points;
  if (points.length < 2) return null;
  if (elapsedSeconds <= points[0]!.elapsed_time_s) return points[0]!.distance_m;
  const last = points[points.length - 1]!;
  if (elapsedSeconds >= last.elapsed_time_s) return last.distance_m;

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid]!.elapsed_time_s <= elapsedSeconds) lo = mid;
    else hi = mid;
  }

  return interpolateDistance(points[lo]!, points[hi]!, elapsedSeconds);
}

function interpolateDistance(
  start: PredictionPoint,
  end: PredictionPoint,
  elapsedSeconds: number,
): number {
  const span = end.elapsed_time_s - start.elapsed_time_s;
  if (span <= 0) return start.distance_m;
  const t = (elapsedSeconds - start.elapsed_time_s) / span;
  return start.distance_m + (end.distance_m - start.distance_m) * t;
}

function rankCheckpoint(checkpoint: CheckpointSeed): number {
  switch (checkpoint.kind) {
    case 'start':
      return 0;
    case 'waypoint':
      return 1;
    case 'poi':
      return 2;
    case 'pause':
      return 3;
    case 'intervalPause':
      return 4;
    case 'end':
      return 5;
    default:
      return 6;
  }
}