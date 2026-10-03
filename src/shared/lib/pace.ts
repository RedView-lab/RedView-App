import { isFootDiscipline, type SportDiscipline } from './discipline';

/** Slower than this is shown as '—' (standing still, very steep scrambles). */
export const MAX_DISPLAY_PACE_S_PER_KM = 30 * 60;

/** Pace in seconds per km, or null when the speed is too low to be meaningful. */
export function kmhToPaceSecPerKm(kmh: number | null | undefined): number | null {
  if (typeof kmh !== 'number' || !Number.isFinite(kmh) || kmh <= 0.5) return null;
  return Math.min(3600 / kmh, MAX_DISPLAY_PACE_S_PER_KM);
}

/** "5:32 /km" (or "5:32" without unit). */
export function formatPaceSeconds(
  secondsPerKm: number | null | undefined,
  opts: { unit?: boolean } = {},
): string {
  if (typeof secondsPerKm !== 'number' || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    return '—';
  }
  const total = Math.round(secondsPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const text = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return opts.unit === false ? text : `${text} /km`;
}

export function formatPace(kmh: number | null | undefined, opts: { unit?: boolean } = {}): string {
  return formatPaceSeconds(kmhToPaceSecPerKm(kmh), opts);
}

/** km/h for cycling, min/km for running and trail. */
export function formatSpeedOrPace(
  kmh: number | null | undefined,
  discipline: SportDiscipline,
  digits = 1,
): string {
  if (isFootDiscipline(discipline)) return formatPace(kmh);
  if (typeof kmh !== 'number' || !Number.isFinite(kmh) || kmh <= 0) return '—';
  return `${kmh.toFixed(digits)} km/h`;
}
