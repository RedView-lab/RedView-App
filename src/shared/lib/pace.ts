import { isFootDiscipline, type SportDiscipline } from './discipline';

/** Plus lent que ceci s'affiche « — » (à l'arrêt, passages très raides). */
const MAX_DISPLAY_PACE_S_PER_KM = 30 * 60;

/** Allure en secondes par km, ou null quand la vitesse est trop faible pour avoir un sens. */
export function kmhToPaceSecPerKm(kmh: number | null | undefined): number | null {
  if (typeof kmh !== 'number' || !Number.isFinite(kmh) || kmh <= 0.5) return null;
  return Math.min(3600 / kmh, MAX_DISPLAY_PACE_S_PER_KM);
}

/** « 5:32 /km » (ou « 5:32 » sans unité). */
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

function formatPace(kmh: number | null | undefined, opts: { unit?: boolean } = {}): string {
  return formatPaceSeconds(kmhToPaceSecPerKm(kmh), opts);
}

/** km/h pour le vélo, min/km pour la course à pied et le trail. */
export function formatSpeedOrPace(
  kmh: number | null | undefined,
  discipline: SportDiscipline,
  digits = 1,
): string {
  if (isFootDiscipline(discipline)) return formatPace(kmh);
  if (typeof kmh !== 'number' || !Number.isFinite(kmh) || kmh <= 0) return '—';
  return `${kmh.toFixed(digits)} km/h`;
}
