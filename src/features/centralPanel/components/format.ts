/**
 * Format helpers shared by the synthesis table & tooltips.
 *
 * All functions return "—" when the input is null / NaN so the UI degrades
 * gracefully before backend data arrives.
 */

const PLACEHOLDER = '—';

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function formatDistanceKm(km: number | null | undefined): string {
  if (!isNum(km)) return PLACEHOLDER;
  if (km >= 100) return km.toFixed(1);
  return km.toFixed(2);
}

export function formatDurationHHMMSS(sec: number | null | undefined): string {
  if (!isNum(sec) || sec < 0) return PLACEHOLDER;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => v.toString().padStart(2, '0')).join(':');
}

export function formatDurationSpaced(sec: number | null | undefined): string {
  if (!isNum(sec) || sec < 0) return PLACEHOLDER;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => v.toString().padStart(2, '0')).join(' : ');
}

export function formatGain(m: number | null | undefined): string {
  if (!isNum(m)) return PLACEHOLDER;
  return `+${Math.round(m)}`;
}

export function formatLoss(m: number | null | undefined): string {
  if (!isNum(m)) return PLACEHOLDER;
  return `${Math.round(m) > 0 ? '-' : ''}${Math.abs(Math.round(m))}`;
}

export function formatMeters(m: number | null | undefined): string {
  if (!isNum(m)) return PLACEHOLDER;
  return `${Math.round(m)} m`;
}

export function formatPercent(p: number | null | undefined, digits = 0): string {
  if (!isNum(p)) return PLACEHOLDER;
  return `${p.toFixed(digits)}%`;
}

export function formatTemperature(c: number | null | undefined): string {
  if (!isNum(c)) return PLACEHOLDER;
  return `${Math.round(c)}°`;
}

export function formatClockHHMM(hhmm: string | null | undefined): string {
  if (!hhmm) return PLACEHOLDER;
  return hhmm;
}

export function formatDayOffset(day: number | null | undefined): string {
  if (!isNum(day) || day < 1) return 'J?';
  return `J${Math.floor(day)}`;
}
