import { readDocumentAppLocale, type AppLocale } from '@/shared/i18n';
import type { RhythmState } from '../../../../types';
import {
  DAY_WINDOW_DAYS,
  DEFAULT_START_MINUTES,
  MIN_RENDER_DURATION_MIN,
  MINUTES_PER_DAY,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
  WEEKDAY_SHORT,
  WEEKDAY_SHORT_EN,
} from '../constants';
import type { StartReference } from '../types';

export function parseStartReference(rhythm?: RhythmState): StartReference {
  const startTime = rhythm?.startTime?.trim() ?? '';
  const startMinutes = parseTimeMinutes(startTime) ?? DEFAULT_START_MINUTES;
  const startDate = rhythm?.startDate?.trim() ?? '';

  if (startDate && startTime) {
    const date = parseDateTime(startDate, startTime);
    if (date) {
      return {
        reference: date,
        hasRealDate: true,
        startMinutes,
      };
    }
  }

  if (startTime) {
    return {
      reference: new Date(2000, 0, 1, Math.floor(startMinutes / 60), startMinutes % 60),
      hasRealDate: false,
      startMinutes,
    };
  }

  return {
    reference: null,
    hasRealDate: false,
    startMinutes: DEFAULT_START_MINUTES,
  };
}

function parseDateTime(dateValue: string, timeValue: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateValue);
  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;

  const date = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimeMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function toDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function parseDayKey(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function buildDayWindow(anchor: Date): Date[] {
  const start = addDays(anchor, -3);
  return Array.from({ length: DAY_WINDOW_DAYS }, (_, index) => addDays(start, index));
}

export function formatDayLabel(date: Date, locale: AppLocale = readDocumentAppLocale()): string {
  const labels = locale === 'en' ? WEEKDAY_SHORT_EN : WEEKDAY_SHORT;
  return labels[date.getDay()] ?? '';
}

export function formatDistanceLabel(distanceKm: number): string {
  if (!Number.isFinite(distanceKm)) return '--';
  if (distanceKm === 0) return '0 km';
  return `${distanceKm.toFixed(1)} km`;
}

export function formatLegDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--';
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `00h${String(minutes).padStart(2, '0')}`;
  return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}m`;
}

export function formatPauseDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '--';
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h${String(remainder).padStart(2, '0')}` : `${hours}h`;
}

export function formatHourLabel(hour: number): string {
  const normalizedMinuteOfDay = ((Math.round(hour) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalizedMinuteOfDay / 60);
  const minutes = normalizedMinuteOfDay % 60;
  const date = new Date(2000, 0, 1, hours, minutes, 0, 0);
  return date
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: minutes > 0 ? '2-digit' : undefined,
      hour12: true,
    })
    .replace('\u202f', ' ');
}

/**
 * Haut d'une minute sur le canevas de l'agenda. Une seule origine pour les
 * heures, la grille, les cartes, la ligne « maintenant » et le glisser-déposer
 * (qui l'inverse) : les cartes partaient 10 px au-dessus de leur heure, et
 * une pause lâchée se posait 10 px plus bas.
 */
export function minuteToCanvasTopPx(minute: number, startMinutes: number, pixelsPerMinute: number): number {
  return (minute - startMinutes) * pixelsPerMinute + TIMELINE_VIEWPORT_TOP_INSET_PX;
}

export function getMinuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function resolveVisualDurationMin(durationMin: number | null | undefined): number {
  if (
    durationMin === null
    || durationMin === undefined
    || !Number.isFinite(durationMin)
    || durationMin <= 0
  ) {
    return 0;
  }
  return Math.max(MIN_RENDER_DURATION_MIN, durationMin);
}