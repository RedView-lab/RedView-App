/**
 * Sun position & sunrise/sunset calculator.
 *
 * Implements the standard astronomical algorithms used by the SunCalc library
 * (Vladimir Agafonkin, BSD-2). Inputs are observer coordinates plus either a
 * real instant (`Date`) or a local wall-clock date/time resolved in an IANA
 * timezone. This keeps the solar system correct for any mapped location rather
 * than accidentally using the viewer machine timezone.
 *
 * Reference:
 *   - https://github.com/mourner/suncalc
 *   - https://gml.noaa.gov/grad/solcalc/calcdetails.html
 */

const PI = Math.PI;
const RAD = PI / 180;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397;
const TIME_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function toJulian(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + J1970;
}

function toDays(date: Date): number {
  return toJulian(date) - J2000;
}

function fromJulian(j: number): Date {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}

function rightAscension(l: number, b: number): number {
  return Math.atan2(
    Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY),
    Math.cos(l),
  );
}

function declination(l: number, b: number): number {
  return Math.asin(
    Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l),
  );
}

function azimuth(H: number, phi: number, dec: number): number {
  return Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
}

function altitude(H: number, phi: number, dec: number): number {
  return Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
  );
}

function siderealTime(d: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + PI;
}

function sunCoords(d: number) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function julianCycle(d: number, lw: number): number {
  return Math.round(d - 0.0009 - lw / (2 * PI));
}

function approxTransit(Ht: number, lw: number, n: number): number {
  return 0.0009 + (Ht + lw) / (2 * PI) + n;
}

function solarTransitJ(ds: number, M: number, L: number): number {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

function hourAngle(h: number, phi: number, d: number): number {
  return Math.acos(
    (Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)),
  );
}

function normalizeTimeZone(timeZone?: string | null): string | null {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null;
  const candidate = timeZone.trim();
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return null;
  }
}

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = TIME_PARTS_FORMATTERS.get(timeZone);
  if (existing) return existing;

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  TIME_PARTS_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

function readHostLocalParts(date: Date): ZonedDateTimeParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

function getZonedDateTimeParts(date: Date, timeZone?: string | null): ZonedDateTimeParts | null {
  if (!date || Number.isNaN(date.getTime())) return null;

  const normalizedTimeZone = normalizeTimeZone(timeZone);
  if (!normalizedTimeZone) {
    return readHostLocalParts(date);
  }

  const parts = getPartsFormatter(normalizedTimeZone).formatToParts(date);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    return null;
  }

  return { year, month, day, hour, minute, second };
}

function partsToUtcMs(parts: ZonedDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}

function sameParts(left: ZonedDateTimeParts | null, right: ZonedDateTimeParts | null): boolean {
  if (!left || !right) return false;
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function compareParts(left: ZonedDateTimeParts, right: ZonedDateTimeParts): number {
  return partsToUtcMs(left) - partsToUtcMs(right);
}

function parseIsoDateParts(dateIso: string): Pick<ZonedDateTimeParts, 'year' | 'month' | 'day'> | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateIso.trim());
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return { year, month, day };
}

function parseClockTime(time: string): Pick<ZonedDateTimeParts, 'hour' | 'minute' | 'second'> | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(time.trim());
  if (!match) return null;

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const second = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }

  return { hour, minute, second };
}

function makeHostLocalDate(parts: ZonedDateTimeParts): Date {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}

function resolveZonedLocalPartsToDate(parts: ZonedDateTimeParts, timeZone?: string | null): Date | null {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  if (!normalizedTimeZone) {
    const fallback = makeHostLocalDate(parts);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const targetMs = partsToUtcMs(parts);
  let guessMs = targetMs;

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const guessParts = getZonedDateTimeParts(new Date(guessMs), normalizedTimeZone);
    if (!guessParts) break;
    const delta = targetMs - partsToUtcMs(guessParts);
    if (delta === 0) break;
    guessMs += delta;
  }

  const exactDate = new Date(guessMs);
  const exactParts = getZonedDateTimeParts(exactDate, normalizedTimeZone);
  if (sameParts(exactParts, parts)) {
    return exactDate;
  }

  let nextFutureCandidate: Date | null = null;
  for (let offsetMinutes = 1; offsetMinutes <= 180; offsetMinutes += 1) {
    const forward = new Date(guessMs + offsetMinutes * MINUTE_MS);
    const forwardParts = getZonedDateTimeParts(forward, normalizedTimeZone);
    if (sameParts(forwardParts, parts)) return forward;
    if (!nextFutureCandidate && forwardParts && compareParts(forwardParts, parts) >= 0) {
      nextFutureCandidate = forward;
    }

    const backward = new Date(guessMs - offsetMinutes * MINUTE_MS);
    const backwardParts = getZonedDateTimeParts(backward, normalizedTimeZone);
    if (sameParts(backwardParts, parts)) return backward;
  }

  return nextFutureCandidate ?? exactDate;
}

function formatDateIsoForZone(date: Date, timeZone?: string | null): string | null {
  const parts = getZonedDateTimeParts(date, timeZone);
  if (!parts) return null;
  const year = parts.year.toString().padStart(4, '0');
  const month = parts.month.toString().padStart(2, '0');
  const day = parts.day.toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface SunPosition {
  azimuth: number;
  altitude: number;
}

export function getSunPosition(date: Date, lat: number, lon: number): SunPosition {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  const azFromSouth = azimuth(H, phi, c.dec) / RAD;
  const azFromNorth = (azFromSouth + 180 + 360) % 360;
  return {
    azimuth: azFromNorth,
    altitude: altitude(H, phi, c.dec) / RAD,
  };
}

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
}

export interface ResolvedSunTimes extends SunTimes {
  sunriseTime: string;
  sunsetTime: string;
}

export function getSunTimes(date: Date, lat: number, lon: number): SunTimes {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const h0 = -0.833 * RAD;

  const arg = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (arg < -1 || arg > 1) {
    return { sunrise: null, sunset: null };
  }

  const w = hourAngle(h0, phi, dec);
  const a = approxTransit(w, lw, n);
  const Jset = solarTransitJ(a, M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
}

export function zonedLocalDateTimeToDate(
  dateIso: string,
  time: string,
  timeZone?: string | null,
): Date | null {
  const dateParts = parseIsoDateParts(dateIso);
  const timeParts = parseClockTime(time);
  if (!dateParts || !timeParts) return null;

  return resolveZonedLocalPartsToDate({
    ...dateParts,
    ...timeParts,
  }, timeZone);
}

export function zonedLocalDateMinutesToDate(
  dateIso: string,
  minutesSinceMidnight: number,
  timeZone?: string | null,
): Date | null {
  const dateParts = parseIsoDateParts(dateIso);
  if (!dateParts) return null;

  const totalSeconds = Math.max(0, Math.round(minutesSinceMidnight * 60));
  const dayOffset = Math.floor(totalSeconds / 86_400);
  const secondsOfDay = totalSeconds % 86_400;
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  const rolledDate = new Date(Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day + dayOffset,
    0,
    0,
    0,
    0,
  ));
  if (Number.isNaN(rolledDate.getTime())) return null;

  return resolveZonedLocalPartsToDate({
    year: rolledDate.getUTCFullYear(),
    month: rolledDate.getUTCMonth() + 1,
    day: rolledDate.getUTCDate(),
    hour,
    minute,
    second,
  }, timeZone);
}

export function getSunPositionForLocalDateTime(
  dateIso: string,
  time: string,
  lat: number,
  lon: number,
  timeZone?: string | null,
): SunPosition | null {
  const instant = zonedLocalDateTimeToDate(dateIso, time, timeZone);
  if (!instant) return null;
  return getSunPosition(instant, lat, lon);
}

export function getSunPositionForLocalMinutes(
  dateIso: string,
  minutesSinceMidnight: number,
  lat: number,
  lon: number,
  timeZone?: string | null,
): SunPosition | null {
  const instant = zonedLocalDateMinutesToDate(dateIso, minutesSinceMidnight, timeZone);
  if (!instant) return null;
  return getSunPosition(instant, lat, lon);
}

export function resolveSunTimesForLocalDay(
  dateOrIso: Date | string,
  lat: number,
  lon: number,
  timeZone?: string | null,
): ResolvedSunTimes {
  const localDateIso =
    typeof dateOrIso === 'string'
      ? dateOrIso.trim()
      : formatDateIsoForZone(new Date(dateOrIso), timeZone);

  if (!localDateIso) {
    return {
      sunrise: null,
      sunset: null,
      sunriseTime: '--:--',
      sunsetTime: '--:--',
    };
  }

  const noon = zonedLocalDateTimeToDate(localDateIso, '12:00', timeZone);
  if (!noon || Number.isNaN(noon.getTime())) {
    return {
      sunrise: null,
      sunset: null,
      sunriseTime: '--:--',
      sunsetTime: '--:--',
    };
  }

  const { sunrise, sunset } = getSunTimes(noon, lat, lon);
  return {
    sunrise,
    sunset,
    sunriseTime: formatHHmm(sunrise, timeZone),
    sunsetTime: formatHHmm(sunset, timeZone),
  };
}

export function formatHHmm(date: Date | null, timeZone?: string | null): string {
  if (!date || Number.isNaN(date.getTime())) return '--:--';
  const parts = getZonedDateTimeParts(date, timeZone);
  if (!parts) return '--:--';
  const hour = parts.hour.toString().padStart(2, '0');
  const minute = parts.minute.toString().padStart(2, '0');
  return `${hour}:${minute}`;
}
