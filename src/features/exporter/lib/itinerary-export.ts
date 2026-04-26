import { Encoder, Profile } from '@garmin/fitsdk';

import { cumulativeRouteLengthsM, projectDistanceAlongRouteM } from '@/features/itineraryPanel/lib/route-distance';
import type { Itinerary, TimelineItem } from '@/features/itineraryPanel/types';

export type ItineraryExportFormat = 'gpx' | 'fit';

interface ExportAnchor {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
  kind: TimelineItem['kind'];
  poiCategory?: TimelineItem['poiCategory'];
}

interface ExportRoutePoint {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
}

const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
const APP_CREATOR = 'RedView';
const FIT_PRODUCT_ID = 1;

export function exportItineraryFile(
  itinerary: Itinerary,
  format: ItineraryExportFormat,
): { fileName: string } {
  const fileName = buildExportFileName(itinerary, format);

  if (format === 'gpx') {
    const xml = buildItineraryGpx(itinerary);
    triggerBrowserDownload(new Blob([xml], { type: 'application/gpx+xml;charset=utf-8' }), fileName);
    return { fileName };
  }

  const fitBytes = buildItineraryFitCourse(itinerary);
  const fitPayload = new Uint8Array(fitBytes.byteLength);
  fitPayload.set(fitBytes);
  triggerBrowserDownload(new Blob([fitPayload], { type: 'application/octet-stream' }), fileName);
  return { fileName };
}

export function buildItineraryGpx(itinerary: Itinerary): string {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints);
  const bounds = buildBounds(routePoints);
  const exportedAt = new Date().toISOString();
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itineraire';

  const waypointXml = anchors
    .map((anchor) => {
      const lines = [
        `<wpt lat="${formatCoordinate(anchor.lat)}" lon="${formatCoordinate(anchor.lon)}">`,
      ];
      if (anchor.elevationM != null) {
        lines.push(`  <ele>${formatDecimal(anchor.elevationM, 1)}</ele>`);
      }
      lines.push(`  <name>${escapeXml(anchor.name)}</name>`);
      lines.push(`  <type>${escapeXml(buildGpxWaypointType(anchor))}</type>`);
      lines.push(`  <desc>${escapeXml(buildWaypointDescription(anchor))}</desc>`);
      lines.push('</wpt>');
      return lines.join('\n');
    })
    .join('\n');

  const routeAnchorXml = anchors
    .map((anchor) => {
      const lines = [
        `    <rtept lat="${formatCoordinate(anchor.lat)}" lon="${formatCoordinate(anchor.lon)}">`,
      ];
      if (anchor.elevationM != null) {
        lines.push(`      <ele>${formatDecimal(anchor.elevationM, 1)}</ele>`);
      }
      lines.push(`      <name>${escapeXml(anchor.name)}</name>`);
      lines.push(`      <type>${escapeXml(buildGpxWaypointType(anchor))}</type>`);
      lines.push('    </rtept>');
      return lines.join('\n');
    })
    .join('\n');

  const trackPointXml = routePoints
    .map((point) => {
      const lines = [
        `      <trkpt lat="${formatCoordinate(point.lat)}" lon="${formatCoordinate(point.lon)}">`,
      ];
      if (point.elevationM != null) {
        lines.push(`        <ele>${formatDecimal(point.elevationM, 1)}</ele>`);
      }
      lines.push('      </trkpt>');
      return lines.join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${APP_CREATOR}" xmlns="${GPX_NAMESPACE}">`,
    '  <metadata>',
    `    <name>${escapeXml(routeName)}</name>`,
    `    <time>${exportedAt}</time>`,
    `    <desc>${escapeXml('Trace exportee depuis RedView sans donnees de vitesse, cadence ou puissance.')}</desc>`,
    `    <bounds minlat="${formatCoordinate(bounds.minLat)}" minlon="${formatCoordinate(bounds.minLon)}" maxlat="${formatCoordinate(bounds.maxLat)}" maxlon="${formatCoordinate(bounds.maxLon)}" />`,
    '  </metadata>',
    waypointXml,
    '  <rte>',
    `    <name>${escapeXml(routeName)}</name>`,
    `    <desc>${escapeXml('Points de guidage et POI exportes pour navigation.')}</desc>`,
    routeAnchorXml,
    '  </rte>',
    '  <trk>',
    `    <name>${escapeXml(routeName)}</name>`,
    '    <trkseg>',
    trackPointXml,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildItineraryFitCourse(itinerary: Itinerary): Uint8Array {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints).filter(
    (anchor) => anchor.kind !== 'start' && anchor.kind !== 'end',
  );
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itineraire';
  const createdAt = new Date();
  const encoder = new Encoder();
  const recordMessages = buildFitRecordMessages(routePoints, createdAt);
  const firstRecord = recordMessages[0];
  const lastRecord = recordMessages[recordMessages.length - 1];

  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: 'course',
    manufacturer: 'development',
    product: FIT_PRODUCT_ID,
    serialNumber: Math.max(1, Math.floor(createdAt.getTime() / 1000)),
    timeCreated: createdAt,
  });

  encoder.onMesg(Profile.MesgNum.COURSE, {
    name: routeName,
    sport: 'cycling',
  });

  encoder.onMesg(Profile.MesgNum.LAP, {
    startTime: firstRecord.timestamp,
    timestamp: lastRecord.timestamp,
    startPositionLat: firstRecord.positionLat,
    startPositionLong: firstRecord.positionLong,
    endPositionLat: lastRecord.positionLat,
    endPositionLong: lastRecord.positionLong,
    totalDistance: lastRecord.distance,
  });

  encoder.onMesg(Profile.MesgNum.EVENT, {
    timestamp: firstRecord.timestamp,
    event: 'timer',
    eventType: 'start',
  });

  for (const record of recordMessages) {
    encoder.onMesg(Profile.MesgNum.RECORD, record);
  }

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    const linkedRecord = findNearestRecordMessage(anchor.distanceM, recordMessages);
    encoder.onMesg(Profile.MesgNum.COURSE_POINT, {
      messageIndex: index,
      timestamp: linkedRecord.timestamp,
      name: anchor.name,
      type: mapAnchorToFitCoursePointType(anchor),
      positionLat: linkedRecord.positionLat,
      positionLong: linkedRecord.positionLong,
      distance: linkedRecord.distance,
    });
  }

  encoder.onMesg(Profile.MesgNum.EVENT, {
    timestamp: lastRecord.timestamp,
    event: 'timer',
    eventType: 'stopDisableAll',
  });

  return encoder.close();
}

function getExportRoutePoints(itinerary: Itinerary): ExportRoutePoint[] {
  const points = itinerary.gpxRoute?.points;
  if (!points || points.length < 2) {
    throw new Error('L\'itineraire actif n\'a pas de trace exportable.');
  }

  const cumulativeLengths = cumulativeRouteLengthsM(points);
  return points.map((point, index) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: Number.isFinite(point.distanceM) ? Math.max(0, point.distanceM as number) : cumulativeLengths[index] ?? 0,
    elevationM: Number.isFinite(point.elevationM) ? (point.elevationM as number) : null,
  }));
}

function collectExportAnchors(
  itinerary: Itinerary,
  routePoints: ExportRoutePoint[],
): ExportAnchor[] {
  const routeDistancePoints = routePoints.map((point) => ({ lat: point.lat, lon: point.lon }));
  const cumulativeLengths = cumulativeRouteLengthsM(routeDistancePoints);
  const totalDistanceM = routePoints[routePoints.length - 1]?.distanceM ?? 0;
  const anchors: ExportAnchor[] = [];
  const seen = new Set<string>();

  for (const item of itinerary.timeline) {
    if (!shouldExportTimelineItem(item)) continue;
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
    });
  }

  anchors.sort((left, right) => left.distanceM - right.distanceM);
  return anchors;
}

function buildFitRecordMessages(routePoints: ExportRoutePoint[], createdAt: Date) {
  const createdAtMs = createdAt.getTime();
  return routePoints.map((point, index) => {
    const record: {
      timestamp: Date;
      positionLat: number;
      positionLong: number;
      distance: number;
      altitude?: number;
    } = {
      timestamp: new Date(createdAtMs + (index * 1000)),
      positionLat: point.lat,
      positionLong: point.lon,
      distance: roundTo(point.distanceM, 2),
    };
    if (point.elevationM != null) {
      record.altitude = roundTo(point.elevationM, 1);
    }
    return record;
  });
}

function findNearestRecordMessage(
  distanceM: number,
  recordMessages: Array<{
    timestamp: Date;
    positionLat: number;
    positionLong: number;
    distance: number;
    altitude?: number;
  }>,
) {
  let nearest = recordMessages[0]!;
  let bestDelta = Math.abs(nearest.distance - distanceM);

  for (let index = 1; index < recordMessages.length; index += 1) {
    const candidate = recordMessages[index]!;
    const delta = Math.abs(candidate.distance - distanceM);
    if (delta >= bestDelta) continue;
    nearest = candidate;
    bestDelta = delta;
  }

  return nearest;
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

function buildGpxWaypointType(anchor: ExportAnchor): string {
  if (anchor.kind === 'start') return 'start';
  if (anchor.kind === 'end') return 'finish';
  if (anchor.kind === 'waypoint') return 'checkpoint';
  return anchor.poiCategory ?? 'poi';
}

function buildWaypointDescription(anchor: ExportAnchor): string {
  if (anchor.kind === 'waypoint') return 'Point de passage exporte depuis la feuille de route.';
  if (anchor.kind === 'poi') return 'POI exporte depuis RedView pour navigation sur montre ou compteur.';
  if (anchor.kind === 'start') return 'Depart du parcours.';
  if (anchor.kind === 'end') return 'Arrivee du parcours.';
  return 'Point exporte depuis RedView.';
}

function mapAnchorToFitCoursePointType(anchor: ExportAnchor): string {
  if (anchor.kind === 'waypoint') return 'checkpoint';

  switch (anchor.poiCategory) {
    case 'fountains':
      return 'water';
    case 'toilets':
      return 'toilet';
    case 'supermarkets':
      return 'store';
    case 'gasStations':
      return 'service';
    case 'bakeries':
    case 'fastFood':
    case 'cafes':
    case 'bars':
    case 'restaurants':
      return 'food';
    case 'bikeShops':
    case 'hotels':
      return 'service';
    case 'refuges':
      return 'shelter';
    case 'passes':
      return 'summit';
    default:
      return 'generic';
  }
}

function buildBounds(routePoints: ExportRoutePoint[]) {
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

function buildExportFileName(itinerary: Itinerary, format: ItineraryExportFormat): string {
  const baseName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'itinerary';
  const sanitized = sanitizeFileName(baseName);
  return `${sanitized}.${format}`;
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

function triggerBrowserDownload(blob: Blob, fileName: string): void {
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

function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

function formatDecimal(value: number, digits: number): string {
  return roundTo(value, digits).toFixed(digits);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}