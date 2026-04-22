/**
 * Sun position & sunrise/sunset calculator.
 *
 * Implements the standard astronomical algorithms used by the SunCalc library
 * (Vladimir Agafonkin, BSD-2). Inputs are date/time and observer coordinates;
 * outputs are sun azimuth (from north, clockwise) and altitude (above horizon)
 * both in degrees, plus sunrise/sunset Date objects in the host timezone.
 *
 * Reference:
 *   - https://en.wikipedia.org/wiki/Position_of_the_Sun
 *   - https://github.com/mourner/suncalc
 */

const PI = Math.PI;
const RAD = PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397; // Earth's obliquity (radians)

// Time scales ----------------------------------------------------------------

function toJulian(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + J1970;
}
function toDays(date: Date): number {
  return toJulian(date) - J2000;
}
function fromJulian(j: number): Date {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}

// Equatorial → horizontal ----------------------------------------------------

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

// Sun position ---------------------------------------------------------------

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

export interface SunPosition {
  /** Azimuth in degrees from true north, clockwise (0..360). */
  azimuth: number;
  /** Altitude in degrees above the horizon (-90..90). */
  altitude: number;
}

export function getSunPosition(date: Date, lat: number, lon: number): SunPosition {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  // SunCalc returns azimuth measured from the south (0=south, +west, -east).
  // Convert to compass bearing: 0=north, clockwise, 0..360.
  const azFromSouth = azimuth(H, phi, c.dec) / RAD;
  const azFromNorth = (azFromSouth + 180 + 360) % 360;
  return {
    azimuth: azFromNorth,
    altitude: altitude(H, phi, c.dec) / RAD,
  };
}

// Sunrise / sunset -----------------------------------------------------------

const J0 = 0.0009;

function julianCycle(d: number, lw: number): number {
  return Math.round(d - J0 - lw / (2 * PI));
}
function approxTransit(Ht: number, lw: number, n: number): number {
  return J0 + (Ht + lw) / (2 * PI) + n;
}
function solarTransitJ(ds: number, M: number, L: number): number {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}
function hourAngle(h: number, phi: number, d: number): number {
  return Math.acos(
    (Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)),
  );
}

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
}

export interface ResolvedSunTimes extends SunTimes {
  sunriseTime: string;
  sunsetTime: string;
}

/**
 * Returns sunrise and sunset for a given calendar day at the observer location.
 * `date` may be any time during the local day; only the date portion matters.
 * Returns `null` for either field at high latitudes when the sun does not
 * cross the horizon (polar day / polar night).
 */
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
  const h0 = -0.833 * RAD; // Standard refraction-corrected horizon

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

/**
 * Shared local-day resolver used by both the sunlight panel and the analysis
 * chart overlay so they stay perfectly aligned for a given day/location.
 */
export function resolveSunTimesForLocalDay(
  dateOrIso: Date | string,
  lat: number,
  lon: number,
): ResolvedSunTimes {
  const noon =
    typeof dateOrIso === 'string'
      ? parseLocalIsoDateAtNoon(dateOrIso)
      : new Date(dateOrIso);

  if (!noon || Number.isNaN(noon.getTime())) {
    return {
      sunrise: null,
      sunset: null,
      sunriseTime: '--:--',
      sunsetTime: '--:--',
    };
  }

  noon.setHours(12, 0, 0, 0);
  const { sunrise, sunset } = getSunTimes(noon, lat, lon);
  return {
    sunrise,
    sunset,
    sunriseTime: formatHHmm(sunrise),
    sunsetTime: formatHHmm(sunset),
  };
}

// Formatting helpers ---------------------------------------------------------

/** Formats a Date as HH:mm in the host timezone. */
export function formatHHmm(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '--:--';
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function parseLocalIsoDateAtNoon(dateIso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateIso.trim());
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}
