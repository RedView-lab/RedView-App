/**
 * Heure murale dans un fuseau IANA donné, indépendamment de celui du
 * navigateur (Intl seulement, sans dépendance).
 *
 * L'app construit ses heures de passage en heure murale du navigateur
 * (`new Date(a, m, j, h, min)`) : « 08:00 » au départ reste 08:00 à l'écran
 * quel que soit le fuseau de la machine. Ces dates sont donc des heures
 * murales du lieu de départ, pas des instants : ce module les convertit en
 * instants (horodatage FIT, prévisions météo) et en heure murale d'un autre
 * lieu (horaires d'ouverture d'un POI dans un autre fuseau).
 */

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      formatter = null; // fuseau inconnu de ce navigateur
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Décalage (ms) de `timeZone` par rapport à UTC à l'instant `instantMs` ; null pour un fuseau inconnu. */
export function timeZoneOffsetMs(instantMs: number, timeZone: string): number | null {
  const formatter = formatterFor(timeZone);
  if (!formatter || !Number.isFinite(instantMs)) return null;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wallAsUtc - (Math.floor(instantMs / 1000) * 1000);
}

/** Décalage (ms) du fuseau du navigateur à `instantMs`. */
function browserOffsetMs(instantMs: number): number {
  return -new Date(instantMs).getTimezoneOffset() * 60_000;
}

/**
 * Instant (ms) de l'heure murale `wallAsUtcMs` (champs de l'heure murale lus
 * comme de l'UTC) dans `timeZone`. Heure qui n'existe pas (printemps) :
 * décalée d'une heure plus tard ; heure répétée (automne) : la première.
 */
function wallClockToInstantMs(wallAsUtcMs: number, timeZone: string): number | null {
  // Décalages encadrants (un changement d'heure au plus dans la journée).
  const before = timeZoneOffsetMs(wallAsUtcMs - DAY_MS, timeZone);
  const after = timeZoneOffsetMs(wallAsUtcMs + DAY_MS, timeZone);
  if (before == null || after == null) return null;
  const valid = [wallAsUtcMs - before, wallAsUtcMs - after]
    .filter((instant) => instant + (timeZoneOffsetMs(instant, timeZone) ?? Number.NaN) === wallAsUtcMs);
  // Heure répétée : la première ; heure sautée : l'offset d'avant le saut.
  return valid.length > 0 ? Math.min(...valid) : wallAsUtcMs - before;
}

const DAY_MS = 86_400_000;

/**
 * Instant d'une date construite en heure murale du navigateur qui désigne en
 * fait l'heure murale de `timeZone` (départ du Rythme et heures de passage).
 * Sans fuseau (ou fuseau inconnu) : la date elle-même.
 */
export function wallClockDateToInstantMs(wallClock: Date, timeZone: string | null | undefined): number {
  const ms = wallClock.getTime();
  if (!timeZone) return ms;
  const wallAsUtc = ms + browserOffsetMs(ms);
  return wallClockToInstantMs(wallAsUtc, timeZone) ?? ms;
}

/**
 * Instant de `dateIso` (AAAA-MM-JJ) à `time` (HH:MM) en heure murale de
 * `timeZone` ; null si la date ou l'heure sont illisibles.
 */
export function zonedDateTimeToInstantMs(dateIso: string, time: string, timeZone: string): number | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!date || !clock) return null;
  const wallAsUtc = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(clock[1]), Number(clock[2]));
  return wallClockToInstantMs(wallAsUtc, timeZone);
}

/**
 * Même instant que `wallClock` (heure murale de `fromTimeZone`), exprimé en
 * heure murale de `toTimeZone` et toujours lu avec les accesseurs locaux
 * (`getHours`, `getDay`…). Sans l'un des fuseaux : la date inchangée.
 */
export function shiftWallClockToTimeZone(
  wallClock: Date,
  fromTimeZone: string | null | undefined,
  toTimeZone: string | null | undefined,
): Date {
  if (!fromTimeZone || !toTimeZone || fromTimeZone === toTimeZone) return wallClock;
  const instant = wallClockDateToInstantMs(wallClock, fromTimeZone);
  const fromOffset = timeZoneOffsetMs(instant, fromTimeZone);
  const toOffset = timeZoneOffsetMs(instant, toTimeZone);
  if (fromOffset == null || toOffset == null || fromOffset === toOffset) return wallClock;
  const shifted = new Date(wallClock.getTime());
  // Par les champs : un changement d'heure du navigateur entre les deux ne décale rien.
  shifted.setMinutes(shifted.getMinutes() + Math.round((toOffset - fromOffset) / 60_000));
  return shifted;
}
