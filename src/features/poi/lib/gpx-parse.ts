import type { GpxRoute } from '../types';
// Module concret, pas le barrel route-metrics : cet analyseur tourne dans le
// worker GPX, et le barrel y tirait 72 modules (BRouter, i18n, un provider
// React dont le runtime de rafraîchissement en dev faisait planter le worker
// sur `window`).
import {
  cleanAndInterpolateElevations,
  isValidElevation,
} from '../../itineraryPanel/lib/route-metrics/elevationSanitizer';

const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Pourquoi un GPX est refusé. Les messages sont du texte source français,
 * traduit à l'affichage (`notify`, `translateAppText` : paires dans
 * translations/dashboard.ts) — ce module tourne dans un worker sans i18n.
 */
export type GpxParseErrorCode = 'not-gpx' | 'no-points' | 'single-point' | 'zero-length';

export const GPX_PARSE_ERROR_MESSAGES: Record<GpxParseErrorCode, string> = {
  'not-gpx': 'Ce fichier n’est pas un GPX lisible.',
  'no-points': 'Ce GPX ne contient aucun point de trace ni de route.',
  'single-point': 'Ce GPX ne contient qu’un seul point : il en faut au moins deux pour tracer un itinéraire.',
  'zero-length': 'Tous les points de ce GPX sont au même endroit : il n’y a pas d’itinéraire à tracer.',
};

export class GpxParseError extends Error {
  readonly code: GpxParseErrorCode;

  constructor(code: GpxParseErrorCode) {
    super(GPX_PARSE_ERROR_MESSAGES[code]);
    this.name = 'GpxParseError';
    this.code = code;
  }
}

export function isGpxParseErrorCode(value: unknown): value is GpxParseErrorCode {
  return typeof value === 'string' && Object.hasOwn(GPX_PARSE_ERROR_MESSAGES, value);
}

/** Longueur sous laquelle une trace n'a pas d'itinéraire (tous les points au même endroit). */
const MIN_ROUTE_LENGTH_M = 1;

/** Un nom de trace plus long est coupé : il devient le nom de l'itinéraire. */
const MAX_NAME_LENGTH = 200;

/**
 * Texte d'un GPX à partir de ses octets. `File.text()` lit toujours de
 * l'UTF-8 : un fichier ISO-8859-1 (anciens Garmin, exports de logiciels
 * européens) y perdait ses accents. Ordre : BOM, puis `encoding` de la
 * déclaration XML, puis UTF-8 strict, puis windows-1252 (sur-ensemble
 * d'ISO-8859-1) pour un fichier non déclaré qui n'est pas de l'UTF-8.
 */
export function decodeGpxBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // UTF-16 sans BOM : « < » suivi ou précédé d'un octet nul.
  if (bytes[0] === 0x3c && bytes[1] === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) return new TextDecoder('utf-16be').decode(bytes);

  // En-tête lu octet par octet (un BOM UTF-8 y devient « ï»¿ »).
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 512));
  const declared = /^(?:ï»¿)?\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]?.trim();
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // Étiquette inconnue du navigateur : on retombe sur la détection.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Préfixe d'espace de noms optionnel (`<gpx:trkpt>`, exports de quelques outils SIG). */
const NS = '(?:[A-Za-z_][\\w.-]*:)?';

const GPX_ROOT_REGEX = new RegExp(`<${NS}gpx(?=[\\s/>])`, 'i');
const GPX_CREATOR_REGEX = new RegExp(`<${NS}gpx\\b[^>]*?\\bcreator\\s*=\\s*(["'])([^"']*)\\1`, 'i');
const ELEVATION_REGEX = new RegExp(`<${NS}ele\\b[^>]*>([\\s\\S]*?)</${NS}ele\\s*>`, 'i');
const NAME_REGEX = new RegExp(`<${NS}name\\b[^>]*>([\\s\\S]*?)</${NS}name\\s*>`, 'i');
const WAYPOINT_TYPE_REGEX = new RegExp(`<${NS}type\\b[^>]*>([\\s\\S]*?)</${NS}type\\s*>`, 'i');
const WAYPOINT_SYM_REGEX = new RegExp(`<${NS}sym\\b[^>]*>([\\s\\S]*?)</${NS}sym\\s*>`, 'i');
const WAYPOINT_DESC_REGEX = new RegExp(`<${NS}desc\\b[^>]*>([\\s\\S]*?)</${NS}desc\\s*>`, 'i');
const WAYPOINT_CMT_REGEX = new RegExp(`<${NS}cmt\\b[^>]*>([\\s\\S]*?)</${NS}cmt\\s*>`, 'i');
/** Catégorie exacte d'un POI exporté par RedView (extension `<redview:category>`). */
const WAYPOINT_REDVIEW_CATEGORY_REGEX = /<redview:category\b[^>]*>([\s\S]*?)<\/redview:category\s*>/i;
const LAT_REGEX = /(?:^|\s)lat\s*=\s*["']([^"']+)["']/i;
const LON_REGEX = /(?:^|\s)lon\s*=\s*["']([^"']+)["']/i;

/** Ouverture d'une trace ou d'un segment de trace : le tracé y est interrompu. */
const TRACK_BREAK_REGEX = new RegExp(`<${NS}trk(?:seg)?(?=[\\s/>])`, 'gi');

const TO_RAD = Math.PI / 180;

export function parseGpxText(text: string): GpxRoute {
  if (!GPX_ROOT_REGEX.test(text)) {
    throw new GpxParseError('not-gpx');
  }

  const name = extractRouteName(text);
  const trackPointOffsets: number[] = [];
  const trackPoints = extractPoints(text, 'trkpt', trackPointOffsets);
  const isTrack = trackPoints.length > 0;
  const routePoints = isTrack ? trackPoints : extractPoints(text, 'rtept');

  assertUsablePoints(routePoints);

  const cleanedPoints = cleanAndInterpolateElevations(routePoints);
  return {
    name,
    points: cleanedPoints,
    pointsKind: isTrack ? 'track' : 'route',
    segmentStarts: isTrack ? extractTrackSegmentStarts(text, trackPointOffsets) : [],
    creator: extractCreator(text),
    waypoints: extractWaypoints(text),
  };
}

/** Refuse une trace sans itinéraire : aucun point, un seul, ou tous au même endroit. */
export function assertUsablePoints(points: GpxRoute['points']): void {
  if (points.length === 0) throw new GpxParseError('no-points');
  if (points.length < 2) throw new GpxParseError('single-point');
  const lengthM = points[points.length - 1]!.distanceM ?? 0;
  if (!(lengthM >= MIN_ROUTE_LENGTH_M)) throw new GpxParseError('zero-length');
}

/** Coordonnées WGS84 utilisables : finies et dans les bornes. */
export function isValidCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Nombre d'un attribut ou d'un texte XML. Accepte la virgule décimale que
 * certains exports localisés écrivent à tort (`<ele>12,5</ele>` donnait 12).
 */
export function parseXmlNumber(raw: string | null | undefined): number {
  if (raw == null) return Number.NaN;
  let value = raw.trim();
  if (value.includes('&')) value = decodeXmlText(value);
  if (value.includes(',') && !value.includes('.')) value = value.replace(',', '.');
  return value.length > 0 ? Number.parseFloat(value) : Number.NaN;
}

function extractCreator(text: string): string | null {
  const creator = GPX_CREATOR_REGEX.exec(text)?.[2]?.trim();
  return creator ? decodeXmlText(creator) : null;
}

function extractElementText(body: string, pattern: RegExp): string | null {
  const raw = pattern.exec(body)?.[1];
  if (raw == null) return null;
  const decoded = decodeXmlText(raw).trim();
  return decoded.length > 0 ? decoded : null;
}

interface ScannedElement {
  index: number;
  attrs: string;
  body: string;
}

const elementScanners = new Map<string, { open: RegExp; close: RegExp }>();

function scannerFor(localName: string): { open: RegExp; close: RegExp } {
  let scanner = elementScanners.get(localName);
  if (!scanner) {
    scanner = {
      open: new RegExp(`<${NS}${localName}(?=[\\s/>])([^>]*)>`, 'gi'),
      close: new RegExp(`</${NS}${localName}\\s*>`, 'gi'),
    };
    elementScanners.set(localName, scanner);
  }
  return scanner;
}

/**
 * Parcourt les éléments `localName` du texte en temps linéaire. Le corps d'un
 * élément s'arrête à sa balise fermante ou, si elle manque (fichier
 * tronqué), à l'ouverture suivante. L'ancienne expression
 * `<trkpt …>[\s\S]*?</trkpt>|<trkpt …/>` essayait d'abord la forme ouverte
 * sur un point auto-fermant et cherchait sa fermeture jusqu'au bout du
 * fichier : quadratique (32 000 points `<trkpt …/>` : 3,9 s ; un fichier de
 * 50 Mo : des heures).
 */
function forEachElement(text: string, localName: string, visit: (element: ScannedElement) => void): void {
  const { open, close } = scannerFor(localName);
  open.lastIndex = 0;
  // Prochaine balise fermante connue : -1 = à chercher, Infinity = il n'y en a plus.
  let nextClose = -1;
  let current = open.exec(text);
  while (current) {
    const index = current.index;
    const end = index + current[0].length;
    const rawAttrs = current[1] ?? '';
    const next = open.exec(text);
    const selfClosing = rawAttrs.endsWith('/');
    let body = '';
    if (!selfClosing) {
      if (nextClose < end) {
        close.lastIndex = end;
        const closing = close.exec(text);
        nextClose = closing ? closing.index : Number.POSITIVE_INFINITY;
      }
      body = text.slice(end, Math.min(nextClose, next ? next.index : text.length));
    }
    visit({ index, attrs: selfClosing ? rawAttrs.slice(0, -1) : rawAttrs, body });
    current = next;
  }
}

function readCoordinates(attrs: string): { lat: number; lon: number } | null {
  const lat = parseXmlNumber(LAT_REGEX.exec(attrs)?.[1]);
  const lon = parseXmlNumber(LON_REGEX.exec(attrs)?.[1]);
  return isValidCoordinate(lat, lon) ? { lat, lon } : null;
}

/** Lit les <wpt> (POI, points de passage) ignorés jusqu'ici par l'import. */
function extractWaypoints(text: string): NonNullable<GpxRoute['waypoints']> {
  const waypoints: NonNullable<GpxRoute['waypoints']> = [];
  forEachElement(text, 'wpt', ({ attrs, body }) => {
    const coordinates = readCoordinates(attrs);
    if (!coordinates) return;
    const elevation = parseXmlNumber(extractElementText(body, ELEVATION_REGEX));
    waypoints.push({
      ...coordinates,
      elevationM: isValidElevation(elevation) ? elevation : null,
      name: extractElementText(body, NAME_REGEX),
      type: extractElementText(body, WAYPOINT_TYPE_REGEX),
      sym: extractElementText(body, WAYPOINT_SYM_REGEX),
      desc: extractElementText(body, WAYPOINT_DESC_REGEX),
      cmt: extractElementText(body, WAYPOINT_CMT_REGEX),
      redviewCategory: extractElementText(body, WAYPOINT_REDVIEW_CATEGORY_REGEX),
    });
  });
  return waypoints;
}

/**
 * Premier `<name>` d'une trace, sinon d'une route, sinon des métadonnées du
 * fichier. Seul l'en-tête de chaque élément est lu (jusqu'à son premier
 * segment ou point) : le nom d'un <wpt> plus loin n'est jamais pris pour celui
 * de la trace, et le coût reste linéaire.
 */
function extractRouteName(text: string): string | null {
  const name =
    findHeaderName(text, 'trk', 'trkseg|trkpt|extensions')
    ?? findHeaderName(text, 'rte', 'rtept|extensions')
    ?? findHeaderName(text, 'metadata', 'author|copyright|link|time|keywords|bounds|extensions');
  if (!name) return null;
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : name;
}

function findHeaderName(text: string, element: string, children: string): string | null {
  const open = new RegExp(`<${NS}${element}(?=[\\s/>])[^>]*>`, 'gi');
  const headerEnd = new RegExp(`<${NS}(?:${children})(?=[\\s/>])|</${NS}${element}\\s*>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = open.exec(text)) !== null) {
    if (match[0].endsWith('/>')) continue;
    const start = match.index + match[0].length;
    headerEnd.lastIndex = start;
    const end = headerEnd.exec(text)?.index ?? text.length;
    const name = extractElementText(text.slice(start, end), NAME_REGEX);
    if (name) return name.replace(/\s+/g, ' ');
    open.lastIndex = Math.max(open.lastIndex, end);
  }
  return null;
}

/**
 * Indices des points qui ouvrent un nouveau segment (`<trkseg>`) ou une
 * nouvelle trace (`<trk>`) — le premier excepté. Entre deux segments, le
 * fichier ne dit rien du chemin suivi : le recoller en ligne droite serait
 * inventer un tracé (cf. importedGpxGaps).
 */
function extractTrackSegmentStarts(text: string, pointOffsets: number[]): number[] {
  const breaks: number[] = [];
  let match: RegExpExecArray | null;
  TRACK_BREAK_REGEX.lastIndex = 0;
  while ((match = TRACK_BREAK_REGEX.exec(text)) !== null) breaks.push(match.index);

  const starts: number[] = [];
  let breakIndex = 0;
  for (let index = 1; index < pointOffsets.length; index += 1) {
    const previous = pointOffsets[index - 1]!;
    const current = pointOffsets[index]!;
    while (breakIndex < breaks.length && breaks[breakIndex]! < previous) breakIndex += 1;
    if (breakIndex < breaks.length && breaks[breakIndex]! < current) starts.push(index);
  }
  return starts;
}

function extractPoints(text: string, element: 'trkpt' | 'rtept', offsets?: number[]): GpxRoute['points'] {
  const points: GpxRoute['points'] = [];
  let distanceM = 0;
  let prevLatRad = 0;
  let prevLonRad = 0;

  forEachElement(text, element, ({ index, attrs, body }) => {
    const coordinates = readCoordinates(attrs);
    if (!coordinates) return;
    const { lat, lon } = coordinates;

    let elevationM: number | null = null;
    const elevationMatch = body ? ELEVATION_REGEX.exec(body) : null;
    if (elevationMatch) {
      const val = parseXmlNumber(elevationMatch[1]);
      if (isValidElevation(val)) elevationM = val;
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
    offsets?.push(index);
  });

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
      default: {
        const parsed = normalized.startsWith('#x')
          ? Number.parseInt(normalized.slice(2), 16)
          : Number.parseInt(normalized.slice(1), 10);
        // Hors de l'Unicode (`&#99999999;`), fromCodePoint lève : l'entité reste telle quelle.
        return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : entity;
      }
    }
  });
}
