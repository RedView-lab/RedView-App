/**
 * Date utilities for the Calendar popover.
 *
 * Locale: French (fr-FR). All helpers are pure and timezone-stable
 * (we always operate at local midnight to avoid the classic
 * `new Date('2025-01-10').getDate() === 9` UTC bug).
 */

const FR_MONTHS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
] as const;

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Mo, Tu, We, Th, Fr, Sa, Su — week starts Monday (Figma spec). */
export const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

/** Parse an ISO `yyyy-mm-dd` string to a local-midnight Date, or null. */
export function parseISO(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date as `yyyy-mm-dd` in local time. */
export function toISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "10 Janvier, 2025" — the long French label shown in the active row. */
export function formatLongFr(d: Date): string {
  return `${d.getDate()} ${FR_MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
}

/** "January 2025" — the English month header used in the Figma design. */
export function formatMonthEn(d: Date): string {
  return `${EN_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Returns midnight today (local). */
export function startOfToday(): Date {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

/** True when both dates are the same calendar day (local). */
export function isSameDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Week-day index with Monday = 0 … Sunday = 6. */
export function mondayIndex(d: Date): number {
  // JS: 0 = Sunday … 6 = Saturday → shift so Monday = 0.
  return (d.getDay() + 6) % 7;
}

/** Move a Date by `n` months, clamping the day to the new month length. */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}
