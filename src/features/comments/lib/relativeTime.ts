/**
 * Date relative d'un message (« il y a 5 min », « hier »), dans la langue de
 * l'interface, comme les fils de Figma ; au-delà d'une semaine, la date.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    formatters.set(locale, formatter);
  }
  return formatter;
}

export function formatRelativeTime(iso: string, now: number, locale: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const elapsed = Math.max(0, now - at);
  const rtf = relativeFormatter(locale);
  if (elapsed < 45_000) return rtf.format(0, 'second');
  if (elapsed < HOUR) return rtf.format(-Math.max(1, Math.round(elapsed / MINUTE)), 'minute');
  if (elapsed < DAY) return rtf.format(-Math.round(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return rtf.format(-Math.round(elapsed / DAY), 'day');
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Date complète (infobulle). */
export function formatFullDate(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
