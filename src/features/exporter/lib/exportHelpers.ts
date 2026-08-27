import { cumulativeRouteLengthsM, projectDistanceAlongRouteM } from '@/features/itineraryPanel/lib/routes';
import type { Itinerary, TimelineItem } from '@/features/itineraryPanel/types';

export interface ExportAnchor {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
  kind: TimelineItem['kind'];
  poiCategory?: TimelineItem['poiCategory'];
  favorite?: boolean;
}

export interface ExportRoutePoint {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
}

export const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
export const KML_NAMESPACE = 'http://www.opengis.net/kml/2.2';
export const APP_CREATOR = 'RedView';
export const FIT_PRODUCT_ID = 1;

export const POI_CATEGORY_TO_GPX_SYM: Record<string, string> = {
  fountains: 'Drinking Water',
  toilets: 'Restroom',
  supermarkets: 'Store',
  gasStations: 'Gas Station',
  bakeries: 'Restaurant',
  fastFood: 'Restaurant',
  cafes: 'Restaurant',
  bars: 'Bar',
  restaurants: 'Restaurant',
  bikeShops: 'Bike Trail',
  hotels: 'Lodging',
  refuges: 'Lodging',
  passes: 'Summit',
};

export const POI_CATEGORY_TO_KML_COLOR: Record<string, string> = {
  fountains: 'ff0047e1',
  toilets: 'ff852c31',
  supermarkets: 'ff00b1f1',
  gasStations: 'ff0035ca',
  bakeries: 'ff0069ff',
  fastFood: 'ff0069ff',
  cafes: 'ff5721ff',
  bars: 'ff3600c7',
  restaurants: 'ff36088b',
  bikeShops: 'ff8e7563',
  hotels: 'ff368200',
  refuges: 'ff00cf7d',
  passes: 'ff8e7563',
};

export const POI_CATEGORY_LABEL_FR: Record<string, string> = {
  fountains: "Point d'eau",
  toilets: 'Toilettes',
  supermarkets: 'Supermarche',
  gasStations: 'Station-service',
  bakeries: 'Boulangerie',
  fastFood: 'Restauration rapide',
  cafes: 'Cafe',
  bars: 'Bar',
  restaurants: 'Restaurant',
  bikeShops: 'Magasin velo',
  hotels: 'Hotel',
  refuges: 'Refuge / gite',
  passes: 'Col',
};

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sanitizeFileName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase() || 'itinerary';
}

export function buildExportFileName(itinerary: Itinerary, format: string): string {
  const baseName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'itinerary';
  const sanitized = sanitizeFileName(baseName);
  return `${sanitized}.${format}`;
}

export function getExportRoutePoints(itinerary: Itinerary): ExportRoutePoint[] {
  const points = itinerary.gpxRoute?.points;
  if (!points || points.length < 2) {
    throw new Error("L'itineraire actif n'a pas de trace exportable.");
  }

  const cumulativeLengths = cumulativeRouteLengthsM(points);
  return points.map((point, index) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: Number.isFinite(point.distanceM) ? Math.max(0, point.distanceM as number) : cumulativeLengths[index] ?? 0,
    elevationM: Number.isFinite(point.elevationM) ? (point.elevationM as number) : null,
  }));
}

function shouldExportTimelineItem(item: TimelineItem): boolean {
  return item.kind === 'start'
    || item.kind === 'end'
    || item.kind === 'waypoint'
    || item.kind === 'poi';
}

function defaultAnchorName(item: TimelineItem): string {
  switch (item.kind) {
    case 'start':
      return 'Depart';
    case 'end':
      return 'Arrivee';
    case 'waypoint':
      return 'Waypoint';
    case 'poi':
      return 'POI';
    default:
      return 'Point';
  }
}

function resolveTimelineDistanceM(
  item: TimelineItem,
  routePoints: Array<{ lat: number; lon: number }>,
  cumulativeLengths: number[],
): number | null {
  if (Number.isFinite(item.distanceKm)) {
    return Math.max(0, (item.distanceKm as number) * 1000);
  }
  if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return null;
  return projectDistanceAlongRouteM(
    { lat: item.lat as number, lon: item.lon as number },
    routePoints,
    cumulativeLengths,
  );
}

function estimateAnchorElevation(distanceM: number, routePoints: ExportRoutePoint[]): number | null {
  let nearest = routePoints[0] ?? null;
  let bestDelta = nearest ? Math.abs(nearest.distanceM - distanceM) : Number.POSITIVE_INFINITY;

  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index]!;
    const delta = Math.abs(point.distanceM - distanceM);
    if (delta >= bestDelta) continue;
    nearest = point;
    bestDelta = delta;
  }

  return nearest?.elevationM ?? null;
}

export function collectExportAnchors(
  itinerary: Itinerary,
  routePoints: ExportRoutePoint[],
  options?: { favoritesOnly?: boolean },
): ExportAnchor[] {
  const favoritesOnly = options?.favoritesOnly ?? false;
  const routeDistancePoints = routePoints.map((point) => ({ lat: point.lat, lon: point.lon }));
  const cumulativeLengths = cumulativeRouteLengthsM(routeDistancePoints);
  const totalDistanceM = routePoints[routePoints.length - 1]?.distanceM ?? 0;
  const anchors: ExportAnchor[] = [];
  const seen = new Set<string>();

  for (const item of itinerary.timeline) {
    if (!shouldExportTimelineItem(item)) continue;
    if (favoritesOnly && item.kind === 'poi' && !item.favorite) continue;
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const lat = item.lat as number;
    const lon = item.lon as number;

    const projectedDistanceM = resolveTimelineDistanceM(item, routeDistancePoints, cumulativeLengths);
    if (projectedDistanceM == null) continue;

    const distanceM = item.kind === 'start'
      ? 0
      : item.kind === 'end'
        ? totalDistanceM
        : Math.max(0, Math.min(totalDistanceM, projectedDistanceM));

    const dedupeKey = `${item.kind}|${item.lat}|${item.lon}|${item.label.trim()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    anchors.push({
      id: item.id,
      name: item.label.trim() || defaultAnchorName(item),
      lat,
      lon,
      distanceM,
      elevationM: estimateAnchorElevation(distanceM, routePoints),
      kind: item.kind,
      poiCategory: item.poiCategory,
      favorite: item.kind === 'poi' ? Boolean(item.favorite) : undefined,
    });
  }

  anchors.sort((left, right) => left.distanceM - right.distanceM);
  return anchors;
}

export function buildBounds(routePoints: ExportRoutePoint[]) {
  let minLat = routePoints[0]!.lat;
  let maxLat = routePoints[0]!.lat;
  let minLon = routePoints[0]!.lon;
  let maxLon = routePoints[0]!.lon;

  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index]!;
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }

  return { minLat, maxLat, minLon, maxLon };
}

export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

export function formatDecimal(value: number, digits: number): string {
  return roundTo(value, digits).toFixed(digits);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
