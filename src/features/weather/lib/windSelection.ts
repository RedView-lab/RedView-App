import type { WindTimeSelection } from '../types';

export const WIND_TIMEZONE = 'Europe/Paris';
const WIND_TIME_STEP_MINUTES = 60;

function clampMinutes(totalMinutes: number): number {
  return Math.max(0, Math.min((24 * 60) - 1, Math.floor(totalMinutes)));
}

export function snapWindMinutes(totalMinutes: number): number {
  const clamped = clampMinutes(totalMinutes);
  return Math.floor(clamped / WIND_TIME_STEP_MINUTES) * WIND_TIME_STEP_MINUTES;
}

export function minutesToWindTime(totalMinutes: number): string {
  const snapped = snapWindMinutes(totalMinutes);
  const hours = String(Math.floor(snapped / 60)).padStart(2, '0');
  const minutes = String(snapped % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function normaliseWindRequestedHourKey(dateIso: string, time: string): string {
  const [hoursText = '0', minutesText = '0'] = time.split(':');
  const totalMinutes = ((Number(hoursText) || 0) * 60) + (Number(minutesText) || 0);
  return `${dateIso}T${minutesToWindTime(totalMinutes)}`;
}

export function normaliseWindSelection<T extends Pick<WindTimeSelection, 'date' | 'time'>>(
  selection: T,
): T {
  return {
    ...selection,
    time: normaliseWindRequestedHourKey(selection.date, selection.time).slice(11),
  };
}

export function windSelectionKey(selection: Pick<WindTimeSelection, 'date' | 'time'>): string {
  return normaliseWindRequestedHourKey(selection.date, selection.time);
}