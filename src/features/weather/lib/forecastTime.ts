export const FORECAST_MAX_DAY_OFFSET = 2;
export const FORECAST_TIME_STEP_MINUTES = 60;

// ── Horizon réel des prévisions (dernière heure de la méta VPS) ──────────
// Le curseur « +2j » ne doit pas dépasser les heures réellement publiées
// (48 h depuis le run du modèle) : au-delà, la carte afficherait la dernière
// heure disponible sous une étiquette fausse.
let forecastHorizonEndMs: number | null = null;
const forecastHorizonListeners = new Set<() => void>();

/** Fixe la dernière heure disponible (ms epoch) ; `null` = inconnue (pas de plafond). */
export function setForecastHorizonEnd(endMs: number | null): void {
  const next = endMs != null && Number.isFinite(endMs) ? endMs : null;
  if (next === forecastHorizonEndMs) return;
  forecastHorizonEndMs = next;
  for (const listener of forecastHorizonListeners) listener();
}

export function getForecastHorizonEnd(): number | null {
  return forecastHorizonEndMs;
}

export function subscribeForecastHorizon(listener: () => void): () => void {
  forecastHorizonListeners.add(listener);
  return () => {
    forecastHorizonListeners.delete(listener);
  };
}

/** Horizon utilisable : ignoré s'il est inconnu ou déjà dépassé (méta périmée). */
function usableForecastHorizon(now: Date): Date | null {
  if (forecastHorizonEndMs == null) return null;
  const end = new Date(forecastHorizonEndMs);
  return end.getTime() >= getForecastWindowStart(now).getTime() ? end : null;
}

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

function floorToStep(minutes: number, stepMinutes: number): number {
  return Math.floor(minutes / stepMinutes) * stepMinutes;
}

function getForecastWindowStart(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setSeconds(0, 0);
  const roundedMinutes = floorToStep((start.getHours() * 60) + start.getMinutes(), FORECAST_TIME_STEP_MINUTES);
  start.setHours(0, 0, 0, 0);
  start.setMinutes(roundedMinutes);
  return start;
}

export function getForecastBaseDate(now: Date = new Date()): Date {
  const base = getForecastWindowStart(now);
  base.setHours(0, 0, 0, 0);
  return base;
}

/** Dernier jour sélectionnable (0..FORECAST_MAX_DAY_OFFSET), borné par l'horizon des prévisions. */
export function getForecastMaxDayOffset(now: Date = new Date()): number {
  const horizon = usableForecastHorizon(now);
  if (!horizon) return FORECAST_MAX_DAY_OFFSET;
  const horizonDay = new Date(horizon);
  horizonDay.setHours(0, 0, 0, 0);
  const days = Math.round((horizonDay.getTime() - getForecastBaseDate(now).getTime()) / 86400000);
  return clamp(days, 0, FORECAST_MAX_DAY_OFFSET);
}

export function getForecastDateForOffset(offset: number, now: Date = new Date()): string {
  const safeOffset = clamp(Math.round(offset), 0, getForecastMaxDayOffset(now));
  return formatLocalDateIso(addDays(getForecastBaseDate(now), safeOffset));
}

export function getForecastOffsetForDate(dateIso: string, now: Date = new Date()): number {
  const date = parseLocalDateIso(dateIso) ?? getForecastBaseDate(now);
  const base = getForecastBaseDate(now);
  const diffMs = date.getTime() - base.getTime();
  return clamp(Math.round(diffMs / 86400000), 0, getForecastMaxDayOffset(now));
}

export function getForecastMinMinutesForDate(dateIso: string, now: Date = new Date()): number {
  const start = getForecastWindowStart(now);
  return dateIso === formatLocalDateIso(start)
    ? (start.getHours() * 60) + start.getMinutes()
    : 0;
}

export function getForecastMaxMinutesForDate(dateIso: string, now: Date = new Date()): number {
  const horizon = usableForecastHorizon(now);
  if (horizon && dateIso === formatLocalDateIso(horizon)) {
    const horizonMinutes = floorToStep((horizon.getHours() * 60) + horizon.getMinutes(), FORECAST_TIME_STEP_MINUTES);
    return Math.max(getForecastMinMinutesForDate(dateIso, now), horizonMinutes);
  }
  return 23 * 60;
}

export function clampForecastSelection(
  selection: { date: string; time: string; forecastDay?: number },
  now: Date = new Date(),
): { date: string; time: string; forecastDay: number } {
  const base = getForecastBaseDate(now);
  const maxDate = addDays(base, getForecastMaxDayOffset(now));

  let date = parseLocalDateIso(selection.date) ?? getForecastBaseDate(now);
  if (date.getTime() < base.getTime()) date = base;
  if (date.getTime() > maxDate.getTime()) date = maxDate;

  const dateIso = formatLocalDateIso(date);
  const minMinutes = getForecastMinMinutesForDate(dateIso, now);
  const maxMinutes = getForecastMaxMinutesForDate(dateIso, now);
  const rawMinutes = timeToMinutes(selection.time || minutesToTime(minMinutes));
  const alignedMinutes = floorToStep(rawMinutes, FORECAST_TIME_STEP_MINUTES);
  const safeMinutes = clamp(alignedMinutes, minMinutes, maxMinutes);

  return {
    date: dateIso,
    time: minutesToTime(safeMinutes),
    forecastDay: getForecastOffsetForDate(dateIso, now),
  };
}