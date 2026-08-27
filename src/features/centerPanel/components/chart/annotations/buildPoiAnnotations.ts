import type { PredictionResult } from '@/features/fitPredictor';
import { poiLabel } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import { buildScheduledTimelineState, parseStartReference } from '@/features/itineraryPanel/sections/timeline/TimelineTimelineView/utils';
import type { Itinerary, PoiCategory, TimelineItem } from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n';
import type { AxisMode } from '../series';
import { normalizeRouteProfile as normalizeChartRouteProfile } from '../series/routeProfile';

const predictionTimelineCache = new WeakMap<PredictionResult, TimelineSample[] | null>();
const predictionProfileCache = new WeakMap<PredictionResult, ElevationSample[] | null>();

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
  kind?: 'poi' | 'pause' | 'waypoint';
  poiCategory?: PoiCategory;
  durationMin?: number | null;
  x: number;
  y: number;
}

export interface BuildPoiAnnotationsOptions {
  includePoi?: boolean;
  includePause?: boolean;
  includeWaypoint?: boolean;
}

export function buildPoiAnnotationsForItinerary(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
  options?: BuildPoiAnnotationsOptions,
): ChartPoiAnnotation[] {
  const includePoi = options?.includePoi ?? true;
  const includePause = options?.includePause ?? false;
  const includeWaypoint = options?.includeWaypoint ?? false;

  if (!includePoi && !includePause && !includeWaypoint) return [];

  const profile =
    normalizeChartRouteProfile(itinerary.gpxRoute?.points ?? null) ??
    normalizePredictionProfile(prediction);
  if (!profile || profile.length < 2) return [];

  const timeline = xMode === 'distance' ? null : getPredictionTimeline(prediction);
  if (xMode !== 'distance' && (!timeline || timeline.length < 2)) return [];

  const result: ChartPoiAnnotation[] = [];

  const addAnnotation = (
    id: string,
    label: string,
    categoryLabel: string,
    distanceKm: number,
    extra: {
      kind: 'poi' | 'pause' | 'waypoint';
      poiCategory?: PoiCategory;
      durationMin?: number | null;
    },
  ) => {
    if (!Number.isFinite(distanceKm)) return;
    const distanceM = distanceKm * 1000;
    const x =
      xMode === 'distance'
        ? distanceKm
        : projectElapsedHoursToX(
            interpolateElapsedHoursFromTimeline(timeline, distanceM),
            xMode,
            itinerary.rhythm.startTime,
          );
    const y = interpolateElevation(profile, distanceM);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    result.push({
      id,
      itineraryId: itinerary.id,
      itineraryName: itinerary.name,
      label,
      categoryLabel,
      kind: extra.kind,
      poiCategory: extra.poiCategory,
      durationMin: extra.durationMin,
      x,
      y,
    });
  };

  // 1. POI rows
  if (includePoi) {
    const poiRows = itinerary.timeline.filter(isVisiblePoiRow);
    for (const row of poiRows) {
      addAnnotation(
        `${itinerary.id}::poi::${row.id}`,
        row.label?.trim() || poiLabel(row.poiCategory ?? 'fountains'),
        row.poiCategory ? poiLabel(row.poiCategory) : 'POI',
        row.distanceKm,
        {
          kind: 'poi',
          poiCategory: row.poiCategory,
        },
      );
    }
  }

  // 2. Pause rows
  if (includePause) {
    // 2a. Manual timeline pauses
    const pauseRows = itinerary.timeline.filter(
      (row) => row.kind === 'pause' && row.visible !== false && Number.isFinite(row.distanceKm),
    );
    for (const row of pauseRows) {
      const durSuffix = row.durationMin ? ` · ${row.durationMin}min` : '';
      addAnnotation(
        `${itinerary.id}::pause::${row.id}`,
        row.label?.trim() || translateAppText('Pause'),
        `${translateAppText('Pause')}${durSuffix}`,
        row.distanceKm as number,
        {
          kind: 'pause',
          durationMin: row.durationMin ?? 15,
        },
      );
    }

    // 2b. Auto-generated interval pauses
    if (
      itinerary.rhythm?.pauseEveryIntervalEnabled &&
      (prediction || itinerary.prediction)
    ) {
      const pred = prediction ?? itinerary.prediction;
      if (pred && pred.points && pred.points.length >= 2) {
        const reference = parseStartReference(itinerary.rhythm);
        const { autoPauses } = buildScheduledTimelineState(
          itinerary.timeline,
          pred,
          reference,
          itinerary.rhythm,
        );
        for (const autoPause of autoPauses) {
          if (autoPause.visible === false || !Number.isFinite(autoPause.distanceKm)) continue;
          const durSuffix = autoPause.durationMin ? ` · ${autoPause.durationMin}min` : '';
          addAnnotation(
            `${itinerary.id}::pause::${autoPause.id}`,
            autoPause.label || translateAppText('Pause'),
            `${translateAppText('Pause')}${durSuffix}`,
            autoPause.distanceKm,
            {
              kind: 'pause',
              durationMin: autoPause.durationMin ?? 15,
            },
          );
        }
      }
    }
  }

  // 3. Waypoint rows
  if (includeWaypoint) {
    const waypointRows = itinerary.timeline.filter(
      (row) => row.kind === 'waypoint' && row.visible !== false && Number.isFinite(row.distanceKm),
    );
    for (const row of waypointRows) {
      addAnnotation(
        `${itinerary.id}::waypoint::${row.id}`,
        row.label?.trim() || translateAppText('Waypoint'),
        translateAppText('Waypoint'),
        row.distanceKm as number,
        {
          kind: 'waypoint',
        },
      );
    }
  }

  return result;
}

function isVisiblePoiRow(row: TimelineItem): row is TimelineItem & { distanceKm: number } {
  return row.kind === 'poi' && row.visible !== false && Number.isFinite(row.distanceKm);
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

