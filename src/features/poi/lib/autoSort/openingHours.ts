// ─────────────────────────────────────────────────────────────────────
// Horaires OSM (`opening_hours`) — évaluation à une heure de passage
// ─────────────────────────────────────────────────────────────────────
//
// Sous-ensemble pragmatique de la spec OSM, suffisant pour l'immense
// majorité des valeurs réelles :
//   « 24/7 », « Mo-Sa 08:30-12:30,15:30-19:30; Su 08:30-13:00 »,
//   « 07:00-19:00 » (sans jours = tous les jours), « Tu-Sa 08:00-14:00; Th off »,
//   « Jul-Sep Mo-Su 12:00-22:00 », « Apr 01 - Oct 15 », « 18:00-02:00 »,
//   « Mo-Sa 12:00-14:30, 19:00-22:00 » (virgule avant une plage), « 08:00+ ».
//
// Sémantique : une règle dont le sélecteur correspond au jour REMPLACE les
// plages des règles précédentes pour ce jour ; un jour non cité est fermé.
// Tout ce qui n'est pas compris (sunrise, PH seul, semaines…) rend
// l'ensemble « unknown » plutôt que de risquer un faux « fermé ».

import type { OpenStatus } from './types';

const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DAY_RE = '(?:mo|tu|we|th|fr|sa|su|ph|sh)';
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';

interface Interval {
  start: number;
  end: number;
}

interface ParsedRule {
  /** Jours de semaine (index JS getDay) ; null = tous. */
  days: Set<number> | null;
  /** Rend vrai si la date est dans la période (mois) ; null = toute l'année. */
  period: ((date: Date) => boolean) | null;
  /** Règle PH/SH : ignorée (jours fériés inconnus). */
  holidayOnly: boolean;
  intervals: Interval[];
}

const parseCache = new Map<string, ParsedRule[] | null>();

function parseClock(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 48 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseTimes(raw: string): Interval[] | null {
  const text = raw.trim();
  if (text === '') return [{ start: 0, end: 24 * 60 }];
  if (text === 'off' || text === 'closed') return [];
  if (text === '24/7' || text === 'open') return [{ start: 0, end: 24 * 60 }];
  const intervals: Interval[] = [];
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (token.endsWith('+')) {
      const start = parseClock(token.slice(0, -1));
      if (start == null) return null;
      intervals.push({ start, end: 24 * 60 });
      continue;
    }
    const [a, b, ...rest] = token.split('-');
    if (a == null || b == null || rest.length > 0) return null;
    const start = parseClock(a);
    let end = parseClock(b);
    if (start == null || end == null) return null;
    if (end <= start) end += 24 * 60;
    intervals.push({ start, end });
  }
  return intervals;
}

function parseDays(raw: string): { days: Set<number> | null; holidayOnly: boolean } | null {
  const days = new Set<number>();
  let holidayOnly = true;
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (t === 'ph' || t === 'sh') continue;
    holidayOnly = false;
    const range = t.split('-');
    if (range.length === 1) {
      const i = WEEKDAYS.indexOf(range[0] as (typeof WEEKDAYS)[number]);
      if (i < 0) return null;
      days.add(i);
    } else if (range.length === 2) {
      const i1 = WEEKDAYS.indexOf(range[0] as (typeof WEEKDAYS)[number]);
      const i2 = WEEKDAYS.indexOf(range[1] as (typeof WEEKDAYS)[number]);
      if (i1 < 0 || i2 < 0) return null;
      for (let i = i1; ; i = (i + 1) % 7) {
        days.add(i);
        if (i === i2) break;
      }
    } else {
      return null;
    }
  }
  return { days: holidayOnly ? null : days, holidayOnly };
}

/** « jul-sep », « apr 01 - oct 15 », « jun » → prédicat sur la date. */
function parsePeriod(raw: string): ((date: Date) => boolean) | null {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const token of raw.split(',')) {
    const m = new RegExp(`^(${MONTH_RE})(?:\\s*(\\d{1,2}))?(?:\\s*-\\s*(${MONTH_RE})(?:\\s*(\\d{1,2}))?)?$`).exec(token.trim());
    if (!m) return null;
    const m1 = MONTHS.indexOf(m[1] as (typeof MONTHS)[number]);
    const d1 = m[2] ? Number(m[2]) : 1;
    const m2 = m[3] ? MONTHS.indexOf(m[3] as (typeof MONTHS)[number]) : m1;
    const d2 = m[4] ? Number(m[4]) : 31;
    ranges.push({ from: m1 * 100 + d1, to: m2 * 100 + d2 });
  }
  return (date) => {
    const key = date.getMonth() * 100 + date.getDate();
    return ranges.some(({ from, to }) => (from <= to ? key >= from && key <= to : key >= from || key <= to));
  };
}

function parseRule(raw: string): ParsedRule | null {
  let rest = raw.trim();
  let period: ParsedRule['period'] = null;
  let days: ParsedRule['days'] = null;
  let holidayOnly = false;

  const periodMatch = new RegExp(
    `^(${MONTH_RE}(?:\\s*\\d{1,2})?(?:\\s*-\\s*${MONTH_RE}(?:\\s*\\d{1,2})?)?(?:\\s*,\\s*${MONTH_RE}(?:\\s*\\d{1,2})?(?:\\s*-\\s*${MONTH_RE}(?:\\s*\\d{1,2})?)?)*)(?=\\s|:|$)`,
  ).exec(rest);
  if (periodMatch) {
    period = parsePeriod(periodMatch[1]!);
    if (!period) return null;
    rest = rest.slice(periodMatch[0].length).replace(/^\s*:?\s*/, '');
  }

  const dayMatch = new RegExp(`^(${DAY_RE}(?:\\s*-\\s*${DAY_RE})?(?:\\s*,\\s*${DAY_RE}(?:\\s*-\\s*${DAY_RE})?)*)(?=\\s|$)`).exec(rest);
  if (dayMatch) {
    const parsed = parseDays(dayMatch[1]!.replace(/\s+/g, ''));
    if (!parsed) return null;
    days = parsed.days;
    holidayOnly = parsed.holidayOnly;
    rest = rest.slice(dayMatch[0].length).trim();
  }

  const intervals = parseTimes(rest);
  if (!intervals) return null;
  return { days, period, holidayOnly, intervals };
}

function parseOpeningHours(raw: string): ParsedRule[] | null {
  const cached = parseCache.get(raw);
  if (cached !== undefined) return cached;

  const normalized = raw
    .toLowerCase()
    .replace(/\|\|/g, ';')
    // « Mo-Fr 08:00-12:00, Sa 09:00-12:00 » : après une heure, la virgule
    // sépare deux règles (mais pas dans « Mo,We,Fr 08:00-12:00 »).
    .replace(new RegExp(`(?<=\\d)\\s*,\\s*(?=${DAY_RE}\\b|${MONTH_RE}\\b)`, 'g'), ';')
    .replace(/\s*-\s*(?=\d)/g, '-')
    .replace(/(\d)\s*-\s*/g, '$1-');

  let rules: ParsedRule[] | null = [];
  for (const chunk of normalized.split(';')) {
    if (!chunk.trim()) continue;
    const rule = parseRule(chunk);
    if (!rule) {
      rules = null;
      break;
    }
    rules.push(rule);
  }
  if (rules && rules.length === 0) rules = null;
  if (parseCache.size > 5000) parseCache.clear();
  parseCache.set(raw, rules);
  return rules;
}

function intervalsForDay(rules: ParsedRule[], date: Date): Interval[] {
  let intervals: Interval[] = [];
  const weekday = date.getDay();
  for (const rule of rules) {
    if (rule.holidayOnly) continue;
    if (rule.period && !rule.period(date)) continue;
    if (rule.days && !rule.days.has(weekday)) continue;
    intervals = rule.intervals;
  }
  return intervals;
}

function statusOnDate(rules: ParsedRule[], date: Date, minuteOfDay: number, closingMarginMin: number): 'open' | 'closed' {
  const today = intervalsForDay(rules, date);
  const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  const spill = intervalsForDay(rules, yesterday)
    .filter((it) => it.end > 24 * 60)
    .map((it) => ({ start: 0, end: it.end - 24 * 60 }));
  const isOpen = [...today, ...spill].some(
    (it) => minuteOfDay >= it.start && minuteOfDay + closingMarginMin <= it.end,
  );
  return isOpen ? 'open' : 'closed';
}

/**
 * Statut d'ouverture à l'arrivée `arrival` (heure locale).
 *
 * @param weekdayKnown Sans date de départ réelle, le jour de semaine est
 *   inconnu : on évalue les 7 jours et on ne conclut que s'ils concordent.
 */
export function evaluateOpeningHoursAt(
  openingHours: string | undefined,
  arrival: Date,
  closingMarginMin: number,
  weekdayKnown = true,
): OpenStatus {
  if (!openingHours) return 'unknown';
  const raw = openingHours.trim();
  if (!raw) return 'unknown';
  if (raw === '24/7') return 'open';

  const rules = parseOpeningHours(raw);
  if (!rules) return 'unknown';

  const minuteOfDay = arrival.getHours() * 60 + arrival.getMinutes();
  if (weekdayKnown) return statusOnDate(rules, arrival, minuteOfDay, closingMarginMin);

  let open = 0;
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(arrival.getFullYear(), arrival.getMonth(), arrival.getDate() + offset);
    if (statusOnDate(rules, day, minuteOfDay, closingMarginMin) === 'open') open++;
  }
  if (open === 7) return 'open';
  if (open === 0) return 'closed';
  return 'unknown';
}

export function isOpen247(openingHours: string | undefined): boolean {
  return openingHours?.trim() === '24/7';
}

/** Plage d'ouverture en minutes depuis minuit ; `end` dépasse 1 440 quand elle finit après minuit. */
export interface OpeningInterval {
  start: number;
  end: number;
}

function sameIntervals(a: readonly Interval[], b: readonly Interval[]): boolean {
  return a.length === b.length && a.every((it, index) => it.start === b[index]!.start && it.end === b[index]!.end);
}

/**
 * Plages d'ouverture du jour de `date` (heure locale), triées : `[]` = fermé
 * ce jour-là, null = horaires absents ou non compris.
 *
 * @param weekdayKnown Sans date de départ réelle, le jour est inconnu : les
 *   plages ne sont rendues que si elles sont les mêmes les 7 jours.
 */
export function openingIntervalsOnDate(
  openingHours: string | undefined,
  date: Date,
  weekdayKnown = true,
): OpeningInterval[] | null {
  const raw = openingHours?.trim();
  if (!raw) return null;
  if (raw === '24/7') return [{ start: 0, end: 24 * 60 }];
  const rules = parseOpeningHours(raw);
  if (!rules) return null;

  const sorted = (day: Date) => [...intervalsForDay(rules, day)].sort((l, r) => l.start - r.start);
  const today = sorted(date);
  if (!weekdayKnown) {
    for (let offset = 1; offset < 7; offset++) {
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
      if (!sameIntervals(today, sorted(day))) return null;
    }
  }
  return today.map(({ start, end }) => ({ start, end }));
}
