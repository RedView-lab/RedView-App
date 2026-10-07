// ============================================
// Sun direction in the viewer's render frame
// ============================================
//
// The scene axes follow the CRS grid (+X east, +Y up, +Z south), not true
// north: a true azimuth is rotated by the grid bearing of true north at the
// scene centre (`trueNorthGridBearingDeg`) before any geometry. Shared by the
// Ensoleillement controller and the photo mode, so both suns agree.

import { getSunPositionForLocalDateTime } from '@/features/sunlight/lib/sun-calc';

const DEG = Math.PI / 180;

/**
 * Unit vector towards the sun in the render frame.
 * @param azimuthDeg true azimuth, clockwise from north
 * @param altitudeDeg elevation above the horizon
 * @param trueNorthGridBearingDeg added to true azimuths to get grid azimuths
 */
export function sunDirectionFromAzAlt(
  azimuthDeg: number,
  altitudeDeg: number,
  trueNorthGridBearingDeg = 0,
): [number, number, number] {
  const az = (azimuthDeg + trueNorthGridBearingDeg) * DEG;
  const alt = altitudeDeg * DEG;
  const cosAlt = Math.cos(alt);
  return [cosAlt * Math.sin(az), Math.sin(alt), -cosAlt * Math.cos(az)];
}

/** Where the scene is: centre in WGS84, its time zone and the grid bearing of true north. */
export interface SunSite {
  lat: number;
  lon: number;
  timeZone: string;
  trueNorthGridBearingDeg: number;
}

export interface PhotoSun {
  azimuthDeg: number;
  altitudeDeg: number;
  /** Unit vector towards the sun, render frame. */
  direction: [number, number, number];
}

/** Real solar position at a local date (YYYY-MM-DD) and time (HH:MM) of the scene. */
export function photoSunAt(site: SunSite, date: string, time: string): PhotoSun {
  const position = getSunPositionForLocalDateTime(date, time, site.lat, site.lon, site.timeZone);
  const azimuthDeg = position ? position.azimuth : 180;
  const altitudeDeg = position ? position.altitude : 45;
  return {
    azimuthDeg,
    altitudeDeg,
    direction: sunDirectionFromAzAlt(azimuthDeg, altitudeDeg, site.trueNorthGridBearingDeg),
  };
}
