import type { GpxRoute } from '../types';

const EARTH_RADIUS_M = 6_371_008.8;

const TRACK_NAME_REGEX = /<trk\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i;
const ROUTE_NAME_REGEX = /<rte\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i;
const TRACK_POINT_REGEX = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>|<trkpt\b([^>]*)\/>/gi;
const ROUTE_POINT_REGEX = /<rtept\b([^>]*)>([\s\S]*?)<\/rtept>|<rtept\b([^>]*)\/>/gi;
const ELEVATION_REGEX = /<ele\b[^>]*>([\s\S]*?)<\/ele>/i;

export function parseGpxText(text: string): GpxRoute {
  if (!/<gpx\b/i.test(text)) {
    throw new Error('Fichier GPX invalide');
  }

  const name = extractRouteName(text);
  const trackPoints = extractPoints(text, TRACK_POINT_REGEX);
  const routePoints = trackPoints.length > 0 ? trackPoints : extractPoints(text, ROUTE_POINT_REGEX);

  if (routePoints.length === 0) {
    throw new Error('Aucun point trouvé dans le GPX');
  }

  if (routePoints.length < 2) {
    throw new Error('GPX doit contenir au moins 2 points');
  }

  return { name, points: routePoints };
}

function extractRouteName(text: string): string | null {
  const match = TRACK_NAME_REGEX.exec(text) ?? ROUTE_NAME_REGEX.exec(text);
  const rawName = match?.[1]?.trim();
  if (!rawName) return null;
  return decodeXmlText(rawName);
}

const LAT_REGEX = /\blat\s*=\s*["']([^"']+)["']/i;
const LON_REGEX = /\blon\s*=\s*["']([^"']+)["']/i;
const TO_RAD = Math.PI / 180;

function extractPoints(text: string, pattern: RegExp): GpxRoute['points'] {
  const points: GpxRoute['points'] = [];
  let distanceM = 0;
  let prevLatRad = 0;
  let prevLonRad = 0;
  let match: RegExpExecArray | null;

  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    const attrs = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';

    const latMatch = LAT_REGEX.exec(attrs);
    const lonMatch = LON_REGEX.exec(attrs);
    if (!latMatch || !lonMatch) continue;

    const lat = Number.parseFloat(latMatch[1]);
    const lon = Number.parseFloat(lonMatch[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    let elevationM: number | null = null;
    const elevationMatch = ELEVATION_REGEX.exec(body);
    if (elevationMatch) {
      const elevationText = elevationMatch[1].trim();
      if (elevationText.length > 0) {
        const val = Number.parseFloat(elevationText.includes('&') ? decodeXmlText(elevationText) : elevationText);
        if (Number.isFinite(val)) elevationM = val;
      }
    }

    const latRad = lat * TO_RAD;
    const lonRad = lon * TO_RAD;

    if (points.length > 0) {
      const dLat = latRad - prevLatRad;
      const dLon = lonRad - prevLonRad;
      const sinDLat2 = Math.sin(dLat * 0.5);
      const sinDLon2 = Math.sin(dLon * 0.5);
      const h = sinDLat2 * sinDLat2 + Math.cos(prevLatRad) * Math.cos(latRad) * sinDLon2 * sinDLon2;
      distanceM += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    prevLatRad = latRad;
    prevLonRad = lonRad;

    points.push({
      lat,
      lon,
      distanceM,
      elevationM,
    });
  }

  return points;
}

function stripCdata(value: string): string {
  const trimmed = value.trim();
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function decodeXmlText(value: string): string {
  const cleaned = stripCdata(value);
  return cleaned.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    switch (normalized) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (normalized.startsWith('#x')) {
          const parsed = Number.parseInt(normalized.slice(2), 16);
          return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
        }
        if (normalized.startsWith('#')) {
          const parsed = Number.parseInt(normalized.slice(1), 10);
          return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
        }
        return entity;
    }
  });
}