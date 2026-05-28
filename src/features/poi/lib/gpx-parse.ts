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

function extractPoints(text: string, pattern: RegExp): GpxRoute['points'] {
  const points: GpxRoute['points'] = [];
  let distanceM = 0;
  let match: RegExpExecArray | null;

  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    const attrs = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';
    const lat = parseCoordinateAttribute(attrs, 'lat');
    const lon = parseCoordinateAttribute(attrs, 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    const elevationMatch = ELEVATION_REGEX.exec(body);
    const elevationText = elevationMatch?.[1]?.trim() ?? '';
    const elevationM = elevationText.length > 0 ? Number.parseFloat(decodeXmlText(elevationText)) : Number.NaN;
    const nextPoint: GpxRoute['points'][number] = {
      lat,
      lon,
      distanceM,
      elevationM: Number.isFinite(elevationM) ? elevationM : null,
    };
    if (points.length > 0) {
      distanceM += haversineM(points[points.length - 1], nextPoint);
      nextPoint.distanceM = distanceM;
    }
    points.push(nextPoint);
  }

  return points;
}

function parseCoordinateAttribute(attrs: string, attribute: 'lat' | 'lon'): number {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attrs);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[2]);
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
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
          const value = Number.parseInt(normalized.slice(2), 16);
          return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
        }
        if (normalized.startsWith('#')) {
          const value = Number.parseInt(normalized.slice(1), 10);
          return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
        }
        return entity;
    }
  });
}

function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}