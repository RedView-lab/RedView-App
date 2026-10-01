import type { GpxRoute } from '../types';
import {
  cleanAndInterpolateElevations,
  isValidElevation,
} from '../../itineraryPanel/lib/route-metrics';

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

  const cleanedPoints = cleanAndInterpolateElevations(routePoints);
  return {
    name,
    points: cleanedPoints,
    creator: extractCreator(text),
    waypoints: extractWaypoints(text),
  };
}

const GPX_CREATOR_REGEX = /<gpx\b[^>]*?\bcreator\s*=\s*(["'])([^"']*)\1/i;
const WAYPOINT_REGEX = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>|<wpt\b([^>]*)\/>/gi;
const WAYPOINT_NAME_REGEX = /<name\b[^>]*>([\s\S]*?)<\/name>/i;
const WAYPOINT_TYPE_REGEX = /<type\b[^>]*>([\s\S]*?)<\/type>/i;
const WAYPOINT_SYM_REGEX = /<sym\b[^>]*>([\s\S]*?)<\/sym>/i;
const WAYPOINT_DESC_REGEX = /<desc\b[^>]*>([\s\S]*?)<\/desc>/i;

function extractCreator(text: string): string | null {
  const creator = GPX_CREATOR_REGEX.exec(text)?.[2]?.trim();
  return creator ? decodeXmlText(creator) : null;
}

function extractWaypointText(body: string, pattern: RegExp): string | null {
  const raw = pattern.exec(body)?.[1];
  if (raw == null) return null;
  const decoded = decodeXmlText(raw).trim();
  return decoded.length > 0 ? decoded : null;
}

/** Lit les <wpt> (POI, points de passage) ignorés jusqu'ici par l'import. */
function extractWaypoints(text: string): NonNullable<GpxRoute['waypoints']> {
  const waypoints: NonNullable<GpxRoute['waypoints']> = [];
  let match: RegExpExecArray | null;

  WAYPOINT_REGEX.lastIndex = 0;
  while ((match = WAYPOINT_REGEX.exec(text)) !== null) {
    const attrs = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';
    const latMatch = LAT_REGEX.exec(attrs);
    const lonMatch = LON_REGEX.exec(attrs);
    if (!latMatch || !lonMatch) continue;
    const lat = Number.parseFloat(latMatch[1]);
    const lon = Number.parseFloat(lonMatch[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const elevationText = extractWaypointText(body, ELEVATION_REGEX);
    const elevation = elevationText != null ? Number.parseFloat(elevationText) : Number.NaN;

    waypoints.push({
      lat,
      lon,
      elevationM: isValidElevation(elevation) ? elevation : null,
      name: extractWaypointText(body, WAYPOINT_NAME_REGEX),
      type: extractWaypointText(body, WAYPOINT_TYPE_REGEX),
      sym: extractWaypointText(body, WAYPOINT_SYM_REGEX),
      desc: extractWaypointText(body, WAYPOINT_DESC_REGEX),
    });
  }

  return waypoints;
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
        if (isValidElevation(val)) elevationM = val;
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