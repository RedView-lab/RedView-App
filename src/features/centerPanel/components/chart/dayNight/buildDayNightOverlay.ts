import type { PredictionResult } from '@/features/fitPredictor';
import { resolveSunTimesForLocalDay } from '@/features/sunlight/lib/sun-calc';
import type { AxisMode } from '../series';

export interface ChartDayNightWindow {
  id: string;
  startX: number;
  endX: number;
}

export interface ChartDayNightMoonMarker {
  id: string;
  x: number;
}

export interface ChartDayNightOverlay {
  dayWindows: ChartDayNightWindow[];
  moonMarkers: ChartDayNightMoonMarker[];
}

interface BuildChartDayNightOverlayOptions {
  prediction: PredictionResult;
  startDate: string;
  startTime: string;
  latitude: number;
  longitude: number;
  xMode: AxisMode;
}

const MIN_WINDOW_WIDTH = 1e-3;

export function buildChartDayNightOverlay({
  prediction,
  startDate,
  startTime,
  latitude,
  longitude,
  xMode,
}: BuildChartDayNightOverlayOptions): ChartDayNightOverlay | null {
  const routeStart = parseLocalDateTime(startDate, startTime);
  if (!routeStart) return null;

  const timeline = buildTimeline(prediction);
  if (timeline.length < 2) return null;

  const maxElapsedSeconds = timeline[timeline.length - 1]?.elapsedSeconds ?? 0;
  if (!Number.isFinite(maxElapsedSeconds) || maxElapsedSeconds <= 0) return null;

  const routeEnd = new Date(routeStart.getTime() + maxElapsedSeconds * 1000);
  const routeStartDay = startOfLocalDay(routeStart);
  const routeEndDay = startOfLocalDay(routeEnd);
  const windows: ChartDayNightWindow[] = [];

  for (
    let cursor = new Date(routeStartDay);
    cursor.getTime() <= routeEndDay.getTime();
    cursor = addDays(cursor, 1)
  ) {
    const { sunrise, sunset } = resolveSunTimesForLocalDay(
      formatLocalDateIso(cursor),
      latitude,
      longitude,
    );
    if (!sunrise || !sunset) continue;

    const daylightStartMs = Math.max(routeStart.getTime(), sunrise.getTime());
    const daylightEndMs = Math.min(routeEnd.getTime(), sunset.getTime());
    if (daylightEndMs - daylightStartMs <= 0) continue;

    const startElapsedSeconds = (daylightStartMs - routeStart.getTime()) / 1000;
    const endElapsedSeconds = (daylightEndMs - routeStart.getTime()) / 1000;
    const startX = projectElapsedSecondsToX(startElapsedSeconds, timeline, xMode, routeStart);
    const endX = projectElapsedSecondsToX(endElapsedSeconds, timeline, xMode, routeStart);
    if (!Number.isFinite(startX) || !Number.isFinite(endX) || endX - startX <= MIN_WINDOW_WIDTH) {
      continue;
    }

    windows.push({
      id: `day-${cursor.toISOString().slice(0, 10)}`,
      startX,
      endX,
    });
  }

  const dayWindows = mergeWindows(windows);
  if (dayWindows.length === 0) return null;

  return {
    dayWindows,
    moonMarkers: buildMoonMarkers(dayWindows),
  };
}

interface TimelinePoint {
  elapsedSeconds: number;
  distanceKm: number;
}

function buildTimeline(prediction: PredictionResult): TimelinePoint[] {
  const deduped: TimelinePoint[] = [];
  for (const point of prediction.points) {
    if (!Number.isFinite(point.elapsed_time_s) || !Number.isFinite(point.distance_m)) continue;
    const elapsedSeconds = point.elapsed_time_s;
    const distanceKm = point.distance_m / 1000;
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.elapsedSeconds - elapsedSeconds) < 1e-6) {
      deduped[deduped.length - 1] = { elapsedSeconds, distanceKm };
      continue;
    }
    deduped.push({ elapsedSeconds, distanceKm });
  }
  return deduped;
}

function projectElapsedSecondsToX(
  elapsedSeconds: number,
  timeline: TimelinePoint[],
  xMode: AxisMode,
  routeStart: Date,
): number {
  if (xMode === 'temps') return elapsedSeconds / 3600;
  if (xMode === 'heure') return elapsedSeconds / 3600 + getClockHours(routeStart);
  return interpolateDistanceAtElapsedSeconds(elapsedSeconds, timeline);
}

function getClockHours(routeStart: Date): number {
  return routeStart.getHours() + routeStart.getMinutes() / 60;
}

function interpolateDistanceAtElapsedSeconds(
  elapsedSeconds: number,
  timeline: TimelinePoint[],
): number {
  if (timeline.length === 0) return Number.NaN;
  if (elapsedSeconds <= timeline[0].elapsedSeconds) return timeline[0].distanceKm;

  const last = timeline[timeline.length - 1];
  if (elapsedSeconds >= last.elapsedSeconds) return last.distanceKm;

  let lo = 0;
  let hi = timeline.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].elapsedSeconds <= elapsedSeconds) lo = mid;
    else hi = mid;
  }

  const start = timeline[lo];
  const end = timeline[hi];
  const span = end.elapsedSeconds - start.elapsedSeconds;
  if (span <= 1e-6) return start.distanceKm;
  const ratio = (elapsedSeconds - start.elapsedSeconds) / span;
  return start.distanceKm + (end.distanceKm - start.distanceKm) * ratio;
}

function mergeWindows(windows: ChartDayNightWindow[]): ChartDayNightWindow[] {
  if (windows.length === 0) return [];

  const sorted = windows
    .slice()
    .sort((left, right) => left.startX - right.startX || left.endX - right.endX);

  const merged: ChartDayNightWindow[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];
    if (current.startX <= previous.endX + MIN_WINDOW_WIDTH) {
      previous.endX = Math.max(previous.endX, current.endX);
      continue;
    }
    merged.push({ ...current });
  }

  return merged.map((window, index) => ({
    id: `day-window-${index + 1}`,
    startX: window.startX,
    endX: window.endX,
  }));
}

function buildMoonMarkers(windows: ChartDayNightWindow[]): ChartDayNightMoonMarker[] {
  const markers: ChartDayNightMoonMarker[] = [];
  for (let index = 0; index < windows.length - 1; index += 1) {
    const current = windows[index];
    const next = windows[index + 1];
    const gap = next.startX - current.endX;
    if (gap <= MIN_WINDOW_WIDTH) continue;
    markers.push({
      id: `moon-${index + 1}`,
      x: current.endX + gap / 2,
    });
  }
  return markers;
}

function parseLocalDateTime(dateIso: string, timeHHmm: string): Date | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(timeHHmm.trim());
  if (!match) return null;

  const [year, month, day] = dateIso.split('-').map((part) => Number.parseInt(part, 10));
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes)
  ) {
    return null;
  }

  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfLocalDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value: Date, dayCount: number): Date {
  const date = new Date(value);
  date.setDate(date.getDate() + dayCount);
  return date;
}

function formatLocalDateIso(value: Date): string {
  const year = value.getFullYear().toString().padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}