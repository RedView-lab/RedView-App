import type { GpxRoute } from '../types';
import {
  assertUsablePoints,
  decodeGpxBytes,
  GpxParseError,
  isGpxParseErrorCode,
  isValidCoordinate,
  parseGpxText,
  parseXmlNumber,
  type GpxParseErrorCode,
} from './gpx-parse';
import {
  cleanAndInterpolateElevations,
  isValidElevation,
} from '../../itineraryPanel/lib/route-metrics/elevationSanitizer';

interface GpxParseWorkerSuccess {
  ok: true;
  route: GpxRoute;
}

interface GpxParseWorkerFailure {
  ok: false;
  message: string;
  code?: GpxParseErrorCode;
}

type GpxParseWorkerResponse = GpxParseWorkerSuccess | GpxParseWorkerFailure;

/**
 * Analyse un fichier .gpx en une trace légère.
 * Gère à la fois <trkpt> (traces) et <rtept> (routes).
 *
 * Un refus motivé du fichier (`GpxParseError` : pas un GPX, aucun point…) est
 * définitif ; seul un plantage du worker relance l'analyse sur le fil
 * principal, puis avec DOMParser.
 */
export async function parseGpxFile(file: File): Promise<GpxRoute> {
  try {
    return await parseGpxFileInWorker(file);
  } catch (error) {
    if (error instanceof GpxParseError) throw error;
    console.warn('[gpx-loader] worker parse failed, falling back to main thread', error);
    const text = decodeGpxBytes(new Uint8Array(await file.arrayBuffer()));
    try {
      return parseGpxText(text);
    } catch (parseError) {
      if (parseError instanceof GpxParseError) throw parseError;
      console.warn('[gpx-loader] fast parser failed, falling back to DOMParser', parseError);
      return parseGpxTextWithDomParser(text);
    }
  }
}

function parseGpxFileInWorker(file: File): Promise<GpxRoute> {
  return new Promise<GpxRoute>((resolve, reject) => {
    const worker = new Worker(new URL('./gpxParseWorker.ts', import.meta.url), { type: 'module' });

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<GpxParseWorkerResponse>) => {
      cleanup();
      const message = event.data;
      if (message.ok) {
        resolve(message.route);
        return;
      }
      reject(isGpxParseErrorCode(message.code) ? new GpxParseError(message.code) : new Error(message.message));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'GPX parse worker crashed'));
    };

    worker.postMessage({ file });
  });
}

function parseGpxTextWithDomParser(text: string): GpxRoute {
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  if (doc.querySelector('parsererror') || doc.documentElement?.localName !== 'gpx') {
    throw new GpxParseError('not-gpx');
  }

  const nameEl = doc.querySelector('trk > name') ?? doc.querySelector('rte > name');
  const name = nameEl?.textContent?.trim() || null;

  const trkpts = doc.querySelectorAll('trkpt');
  const rtepts = doc.querySelectorAll('rtept');
  const isTrack = trkpts.length > 0;
  const raw = isTrack ? trkpts : rtepts;

  const points: GpxRoute['points'] = [];
  // Points qui ouvrent un nouveau segment de trace (cf. GpxRoute.segmentStarts).
  const segmentStarts: number[] = [];
  let previousSegment: Element | null = null;
  let distanceM = 0;

  for (const element of raw) {
    const lat = parseXmlNumber(element.getAttribute('lat'));
    const lon = parseXmlNumber(element.getAttribute('lon'));
    if (!isValidCoordinate(lat, lon)) {
      continue;
    }
    if (isTrack && points.length > 0 && element.parentElement !== previousSegment) {
      segmentStarts.push(points.length);
    }
    previousSegment = element.parentElement;

    const elevationM = parseXmlNumber(element.querySelector('ele')?.textContent);
    const nextPoint: GpxRoute['points'][number] = {
      lat,
      lon,
      distanceM,
      elevationM: isValidElevation(elevationM) ? elevationM : null,
    };
    if (points.length > 0) {
      distanceM += haversineM(points[points.length - 1], nextPoint);
      nextPoint.distanceM = distanceM;
    }
    points.push(nextPoint);
  }

  assertUsablePoints(points);

  const cleanedPoints = cleanAndInterpolateElevations(points);
  const waypoints: NonNullable<GpxRoute['waypoints']> = [];
  for (const element of doc.querySelectorAll('wpt')) {
    const lat = parseXmlNumber(element.getAttribute('lat'));
    const lon = parseXmlNumber(element.getAttribute('lon'));
    if (!isValidCoordinate(lat, lon)) continue;
    const childText = (tag: string) => element.querySelector(tag)?.textContent?.trim() || null;
    const elevationM = parseXmlNumber(childText('ele'));
    waypoints.push({
      lat,
      lon,
      elevationM: isValidElevation(elevationM) ? elevationM : null,
      name: childText('name'),
      type: childText('type'),
      sym: childText('sym'),
      desc: childText('desc'),
    });
  }
  return {
    name,
    points: cleanedPoints,
    pointsKind: isTrack ? 'track' : 'route',
    segmentStarts,
    creator: doc.documentElement.getAttribute('creator')?.trim() || null,
    waypoints,
  };
}

// ── Échantillonnage selon la distance pour les requêtes Overpass en corridor ──

const EARTH_RADIUS_M = 6_371_008.8;

/** Distance orthodromique en mètres entre deux paires lat/lon. */
function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Longueur totale d'une polyligne en mètres (somme des longueurs de segments). */
export function routeLengthM(points: { lat: number; lon: number; distanceM?: number | null }[]): number {
  if (points.length <= 1) return 0;
  const last = points[points.length - 1];
  if (typeof last?.distanceM === 'number' && Number.isFinite(last.distanceM) && last.distanceM > 0) {
    return last.distanceM;
  }
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i - 1], points[i]);
  }
  return total;
}
