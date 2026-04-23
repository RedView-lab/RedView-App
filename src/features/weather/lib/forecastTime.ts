export const FORECAST_MAX_DAY_OFFSET = 2;
export const FORECAST_TIME_STEP_MINUTES = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function formatLocalDateIso(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDateIso(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function timeToMinutes(time: string): number {
  const [hoursText, minutesText] = time.split(':');
  const hours = Number(hoursText || 0);
  const minutes = Number(minutesText || 0);
  return clamp(hours * 60 + minutes, 0, (24 * 60) - 1);
}

export function minutesToTime(totalMinutes: number): string {
  const clamped = clamp(totalMinutes, 0, (24 * 60) - 1);
  const hours = String(Math.floor(clamped / 60)).padStart(2, '0');
  const minutes = String(clamped % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function roundUpToStep(minutes: number, stepMinutes: number): number {
  return Math.ceil(minutes / stepMinutes) * stepMinutes;
}

function roundToStep(minutes: number, stepMinutes: number): number {
  return Math.round(minutes / stepMinutes) * stepMinutes;
}

export function getForecastWindowStart(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setSeconds(0, 0);
  const roundedMinutes = roundUpToStep((start.getHours() * 60) + start.getMinutes(), FORECAST_TIME_STEP_MINUTES);
  start.setHours(0, 0, 0, 0);
  if (roundedMinutes >= 24 * 60) {
    start.setDate(start.getDate() + 1);
    return start;
  }
  start.setMinutes(roundedMinutes);
  return start;
}

export function getForecastBaseDate(now: Date = new Date()): Date {
  const base = getForecastWindowStart(now);
  base.setHours(0, 0, 0, 0);
  return base;
}

export function getForecastDateForOffset(offset: number, now: Date = new Date()): string {
  const safeOffset = clamp(Math.round(offset), 0, FORECAST_MAX_DAY_OFFSET);
  return formatLocalDateIso(addDays(getForecastBaseDate(now), safeOffset));
}

export function getForecastOffsetForDate(dateIso: string, now: Date = new Date()): number {
  const date = parseLocalDateIso(dateIso) ?? getForecastBaseDate(now);
  const base = getForecastBaseDate(now);
  const diffMs = date.getTime() - base.getTime();
  return clamp(Math.round(diffMs / 86400000), 0, FORECAST_MAX_DAY_OFFSET);
}

export function getForecastMinMinutesForDate(dateIso: string, now: Date = new Date()): number {
  const start = getForecastWindowStart(now);
  return dateIso === formatLocalDateIso(start)
    ? (start.getHours() * 60) + start.getMinutes()
    : 0;
}

export function getForecastMaxMinutesForDate(_dateIso: string): number {
  return 23 * 60;
}

export function clampForecastSelection(
  selection: { date: string; time: string; forecastDay?: number },
  now: Date = new Date(),
): { date: string; time: string; forecastDay: number } {
  const base = getForecastBaseDate(now);
  const maxDate = addDays(base, FORECAST_MAX_DAY_OFFSET);

  let date = parseLocalDateIso(selection.date) ?? getForecastBaseDate(now);
  if (date.getTime() < base.getTime()) date = base;
  if (date.getTime() > maxDate.getTime()) date = maxDate;

  const dateIso = formatLocalDateIso(date);
  const minMinutes = getForecastMinMinutesForDate(dateIso, now);
  const maxMinutes = getForecastMaxMinutesForDate(dateIso);
  const rawMinutes = timeToMinutes(selection.time || minutesToTime(minMinutes));
  const alignedMinutes = roundToStep(rawMinutes, FORECAST_TIME_STEP_MINUTES);
  const safeMinutes = clamp(alignedMinutes, minMinutes, maxMinutes);

  return {
    date: dateIso,
    time: minutesToTime(safeMinutes),
    forecastDay: getForecastOffsetForDate(dateIso, now),
  };
}