// ============================================
// LiDAR viewer tools — value formatting (distances, angles, coordinates)
// ============================================

import proj4 from 'proj4';
import { readDocumentAppLocale } from '@/shared/i18n/config';
import { fromWgs84 } from '../../lib/coordConvert';
import type { DetectedCrs } from '../../types';

const numberFormats = new Map<string, Intl.NumberFormat>();

function formatNumber(value: number, fractionDigits: number): string {
  const locale = readDocumentAppLocale();
  const key = `${locale}:${fractionDigits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    numberFormats.set(key, format);
  }
  return format.format(value);
}

/** 8.4 m · 124 m · 1.24 km · 12.4 km */
export function formatDistance(meters: number): string {
  const m = Math.abs(meters);
  if (m < 10) return `${formatNumber(meters, 1)} m`;
  if (m < 1000) return `${formatNumber(meters, 0)} m`;
  return `${formatNumber(meters / 1000, m < 10_000 ? 2 : 1)} km`;
}

/** Signed elevation difference: +312 m / −40 m. */
export function formatElevationDelta(meters: number): string {
  const abs = Math.abs(meters);
  const digits = abs < 10 ? 1 : 0;
  if (Number(abs.toFixed(digits)) === 0) return '±0 m';
  return `${meters > 0 ? '+' : '−'}${formatNumber(abs, digits)} m`;
}

export function formatAltitude(meters: number): string {
  return `${formatNumber(Math.round(meters), 0)} m`;
}

export function formatAngle(degrees: number, fractionDigits = 0): string {
  return `${formatNumber(degrees, fractionDigits)}°`;
}

export function formatPercent(ratio: number): string {
  return `${formatNumber(ratio * 100, 0)} %`;
}

/** 2 430 m² · 2.43 ha · 1.24 km² */
export function formatArea(squareMeters: number): string {
  if (squareMeters < 10_000) return `${formatNumber(squareMeters, 0)} m²`;
  if (squareMeters < 1_000_000) return `${formatNumber(squareMeters / 10_000, 2)} ha`;
  return `${formatNumber(squareMeters / 1_000_000, 2)} km²`;
}

const COMPASS_FR = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'] as const;
const COMPASS_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** 8-point compass label of a true azimuth (French uses O for west). */
export function formatAspect(azimuthDeg: number): string {
  const labels = readDocumentAppLocale() === 'fr' ? COMPASS_FR : COMPASS_EN;
  return labels[Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8]!;
}

// ── Coordinates ────────────────────────────────────────────────────────────

/** Formats cycled by a click on the coordinates of the context menu. */
export type CoordinateFormat = 'dd' | 'dms' | 'utm' | 'native';
export const COORDINATE_FORMATS: readonly CoordinateFormat[] = ['dd', 'dms', 'utm', 'native'];

const NATIVE_CRS_LABEL: Partial<Record<string, string>> = {
  LAMB93: 'L93',
  RGR92UTM40S: 'UTM 40S',
  CH1903_LV95: 'LV95',
  NZTM2000: 'NZTM',
  RD_NEW: 'RD',
  BL72: 'BL72',
};

function nativeCrsLabel(crs: DetectedCrs): string {
  if (crs.startsWith('JGD2011_ZONE_')) return `JGD2011 ${Number(crs.slice(-2))}`;
  return NATIVE_CRS_LABEL[crs] ?? crs;
}

function formatDms(value: number, positive: string, negative: string): string {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let sec = Math.round(((abs - deg) * 60 - min) * 600) / 10;
  if (sec >= 60) { sec = 0; min += 1; }
  if (min >= 60) { min = 0; deg += 1; }
  return `${deg}°${String(min).padStart(2, '0')}'${sec.toFixed(1).padStart(4, '0')}"${value >= 0 ? positive : negative}`;
}

const UTM_BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const utmConverters = new Map<string, proj4.Converter>();

/** UTM zone (Norway/Svalbard exceptions included) and MGRS latitude band. */
function utmZoneOf(lon: number, lat: number): { zone: number; band: string } {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  const band = UTM_BANDS[Math.max(0, Math.min(UTM_BANDS.length - 1, Math.floor((lat + 80) / 8)))]!;
  return { zone, band };
}

function formatUtm(lon: number, lat: number): string {
  const { zone, band } = utmZoneOf(lon, lat);
  const south = lat < 0;
  const key = `${zone}${south ? 'S' : 'N'}`;
  let converter = utmConverters.get(key);
  if (!converter) {
    converter = proj4('EPSG:4326', `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`);
    utmConverters.set(key, converter);
  }
  const [easting, northing] = converter.forward([lon, lat]) as [number, number];
  return `${zone}${band} ${Math.round(easting)} ${Math.round(northing)}`;
}

export interface FormattedCoordinates {
  /** System name: WGS84, DMS, UTM, L93, LV95… */
  system: string;
  value: string;
  /** Text copied to the clipboard (grid systems keep their name). */
  clipboard: string;
}

export function formatCoordinates(lon: number, lat: number, format: CoordinateFormat, crs: DetectedCrs): FormattedCoordinates {
  switch (format) {
    case 'dms': {
      const value = `${formatDms(lat, 'N', 'S')} ${formatDms(lon, 'E', 'W')}`;
      return { system: 'DMS', value, clipboard: value };
    }
    case 'utm': {
      const value = formatUtm(lon, lat);
      return { system: 'UTM', value, clipboard: `UTM ${value}` };
    }
    case 'native': {
      const [x, y] = fromWgs84(lon, lat, crs);
      const system = nativeCrsLabel(crs);
      const value = `${Math.round(x)} ${Math.round(y)}`;
      return { system, value, clipboard: `${system} ${value}` };
    }
    default: {
      const value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      return { system: 'WGS84', value, clipboard: value };
    }
  }
}

/**
 * Topographic map of the national mapping agency at the point (IGN
 * Géoportail in France, swisstopo in Switzerland), Google terrain elsewhere.
 */
export function buildTopoMapUrl(lon: number, lat: number, crs: DetectedCrs): string {
  if (crs === 'LAMB93' || crs === 'RGR92UTM40S') {
    const url = new URL('https://www.geoportail.gouv.fr/carte');
    url.searchParams.set('c', `${lon.toFixed(6)},${lat.toFixed(6)}`);
    url.searchParams.set('z', '16');
    url.searchParams.set('l0', 'GEOGRAPHICALGRIDSYSTEMS.MAPS::GEOPORTAIL:OGC:WMTS(1)');
    url.searchParams.set('permalink', 'yes');
    return url.toString();
  }
  if (crs === 'CH1903_LV95') {
    const [e, n] = fromWgs84(lon, lat, crs);
    return `https://map.geo.admin.ch/#/map?lang=fr&center=${Math.round(e)},${Math.round(n)}&z=9&bgLayer=ch.swisstopo.pixelkarte-farbe&crosshair=marker`;
  }
  const url = new URL('https://www.google.com/maps/@');
  url.searchParams.set('api', '1');
  url.searchParams.set('map_action', 'map');
  url.searchParams.set('center', `${lat.toFixed(6)},${lon.toFixed(6)}`);
  url.searchParams.set('zoom', '16');
  url.searchParams.set('basemap', 'terrain');
  return url.toString();
}
