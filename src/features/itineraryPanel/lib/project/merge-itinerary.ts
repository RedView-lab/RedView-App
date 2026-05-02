import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
} from '../routes';
import {
  buildImportedRouteMetrics,
  normalizeImportedRoutePoints,
} from '../routes';
import { formatGpsCoordinateLabel } from '../geocoding';
import type {
  Itinerary,
  ItineraryForbiddenZone,
  ItineraryProject,
  TimelineItem,
} from '../../types';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

export interface MergeItineraryConnectorSegment {
  points: NonNullable<Itinerary['gpxRoute']>['points'];
  distanceM?: number;
  tarmacPercent?: number;
  offroadPercent?: number;
}

export interface MergeItineraryProjectResult {
  project: ItineraryProject;
  mergedItineraryId: string;
  removedItineraryId: string;
  mergedItineraryName: string;
  connectorUsed: boolean;
}

export const MERGE_CONNECT_THRESHOLD_M = 35;

function hasMergeableRoute(itinerary: Itinerary | null | undefined): itinerary is Itinerary & {
  gpxRoute: NonNullable<Itinerary['gpxRoute']>;
} {
  return Boolean(itinerary?.gpxRoute && itinerary.gpxRoute.points.length >= 2);
}

function cloneRoutePoints(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  return points.map((point) => ({ ...point }));
}

function samePoint(
  left: Pick<RoutePoint, 'lat' | 'lon'> | null | undefined,
  right: Pick<RoutePoint, 'lat' | 'lon'> | null | undefined,
): boolean {
  return left?.lat === right?.lat && left?.lon === right?.lon;
}

function haversineDistanceM(
  left: Pick<RoutePoint, 'lat' | 'lon'>,
  right: Pick<RoutePoint, 'lat' | 'lon'>,
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusM = 6_371_008.8;
  const dLat = toRad(right.lat - left.lat);
  const dLon = toRad(right.lon - left.lon);
  const lat1 = toRad(left.lat);
  const lat2 = toRad(right.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(h));
}

export function shouldRouteMergedGap(
  source: Itinerary,
  target: Itinerary,
  thresholdM = MERGE_CONNECT_THRESHOLD_M,
): boolean {
  if (!hasMergeableRoute(source) || !hasMergeableRoute(target)) return false;
  const sourceEnd = source.gpxRoute.points[source.gpxRoute.points.length - 1];
  const targetStart = target.gpxRoute.points[0];
  if (!sourceEnd || !targetStart) return false;
  return haversineDistanceM(sourceEnd, targetStart) > thresholdM;
}

function appendSegment(
  base: NonNullable<Itinerary['gpxRoute']>['points'],
  segment: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  if (base.length === 0) return cloneRoutePoints(segment);
  if (segment.length === 0) return cloneRoutePoints(base);
  const tail = samePoint(base[base.length - 1], segment[0]) ? segment.slice(1) : segment;
  return [...cloneRoutePoints(base), ...cloneRoutePoints(tail)];
}

function mergeForbiddenZones(
  sourceZones: ItineraryForbiddenZone[] | undefined,
  targetZones: ItineraryForbiddenZone[] | undefined,
): ItineraryForbiddenZone[] | undefined {
  const merged = [...(sourceZones ?? []), ...(targetZones ?? [])].map((zone) => ({
    ...zone,
    points: zone.points.map((point) => ({ ...point })),
  }));
  return merged.length > 0 ? merged : undefined;
}

function isRoutableTimelineItem(
  row: TimelineItem | null | undefined,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row &&
      (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end') &&
      row.lat != null &&
      row.lon != null,
  );
}

function resolveStartRow(itinerary: Itinerary, routeStart: RoutePoint): TimelineItem {
  const start = itinerary.timeline.find((row) => row.kind === 'start');
  return {
    id: 'start',
    kind: 'start',
    label: start?.label ?? formatGpsCoordinateLabel(routeStart.lon, routeStart.lat),
    distanceKm: 0,
    lat: routeStart.lat,
    lon: routeStart.lon,
  };
}

function resolveEndRow(
  itinerary: Itinerary,
  routeEnd: RoutePoint,
  distanceKm: number,
): TimelineItem {
  const end = itinerary.timeline.find((row) => row.kind === 'end');
  return {
    id: 'end',
    kind: 'end',
    label: end?.label ?? formatGpsCoordinateLabel(routeEnd.lon, routeEnd.lat),
    distanceKm,
    lat: routeEnd.lat,
    lon: routeEnd.lon,
  };
}

function projectDistanceKmOnRoute(
  row: TimelineItem & { lat: number; lon: number },
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  routeDistances: number[],
): number | null {
  const projected = projectPointAlongRoute(row, routePoints, routeDistances);
  if (!projected) return null;
  return Math.round((projected.distanceM / 1000) * 10) / 10;
}

function buildMergedTimeline(
  source: Itinerary,
  target: Itinerary,
  mergedPoints: NonNullable<Itinerary['gpxRoute']>['points'],
  totalDistanceKm: number,
): TimelineItem[] {
  const routeStart = mergedPoints[0];
  const routeEnd = mergedPoints[mergedPoints.length - 1] ?? routeStart;
  if (!routeStart || !routeEnd) {
    return [
      { id: 'start', kind: 'start', label: 'Rechercher un lieu', distanceKm: 0 },
      { id: 'end', kind: 'end', label: 'Rechercher un lieu', distanceKm: null },
    ];
  }

  const routeDistances = cumulativeRouteLengthsM(mergedPoints);
  const sourceRows = source.timeline.filter(isRoutableTimelineItem);
  const targetRows = target.timeline.filter(isRoutableTimelineItem);
  const middleRows = [
    ...sourceRows.slice(1),
    ...targetRows.slice(0, -1),
  ];
  const mergeSeed = Date.now();

  return [
    resolveStartRow(source, routeStart),
    ...middleRows.map((row, index) => ({
      id: `merge-step-${mergeSeed}-${index + 1}`,
      kind: 'waypoint' as const,
      label: row.label,
      distanceKm: projectDistanceKmOnRoute(row, mergedPoints, routeDistances),
      favorite: row.favorite,
      visible: row.visible,
    })),
    resolveEndRow(target, routeEnd, totalDistanceKm),
  ];
}

function mergeSurfaceMetrics(
  source: Itinerary,
  sourceDistanceM: number,
  target: Itinerary,
  targetDistanceM: number,
  connector: MergeItineraryConnectorSegment | undefined,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  const buckets = [
    {
      distanceM: Math.max(sourceDistanceM, 0),
      tarmacPercent: source.metrics?.tarmacPercent,
      offroadPercent: source.metrics?.offroadPercent,
    },
    {
      distanceM: Math.max(targetDistanceM, 0),
      tarmacPercent: target.metrics?.tarmacPercent,
      offroadPercent: target.metrics?.offroadPercent,
    },
    {
      distanceM: Math.max(connector?.distanceM ?? routeLengthM(connector?.points ?? []), 0),
      tarmacPercent: connector?.tarmacPercent,
      offroadPercent: connector?.offroadPercent,
    },
  ];

  let totalClassifiedDistanceM = 0;
  let totalTarmacDistanceM = 0;
  let totalOffroadDistanceM = 0;

  for (const bucket of buckets) {
    if (!(bucket.distanceM > 0)) continue;
    if (bucket.tarmacPercent != null) {
      totalTarmacDistanceM += (bucket.tarmacPercent / 100) * bucket.distanceM;
      totalClassifiedDistanceM += (bucket.tarmacPercent / 100) * bucket.distanceM;
    }
    if (bucket.offroadPercent != null) {
      totalOffroadDistanceM += (bucket.offroadPercent / 100) * bucket.distanceM;
      totalClassifiedDistanceM += (bucket.offroadPercent / 100) * bucket.distanceM;
    }
  }

  if (!(totalClassifiedDistanceM > 0)) return undefined;

  return {
    tarmacPercent: Math.round((totalTarmacDistanceM / totalClassifiedDistanceM) * 100),
    offroadPercent: Math.round((totalOffroadDistanceM / totalClassifiedDistanceM) * 100),
  };
}

export function mergeItineraryProject(
  project: ItineraryProject,
  sourceId: string,
  targetId: string,
  options?: {
    connector?: MergeItineraryConnectorSegment;
  },
): MergeItineraryProjectResult | null {
  if (sourceId === targetId) return null;

  const source = project.itineraries.find((itinerary) => itinerary.id === sourceId);
  const target = project.itineraries.find((itinerary) => itinerary.id === targetId);
  if (!hasMergeableRoute(source) || !hasMergeableRoute(target)) return null;

  const sourcePoints = normalizeImportedRoutePoints(cloneRoutePoints(source.gpxRoute.points));
  const connectorPoints = options?.connector?.points?.length
    ? normalizeImportedRoutePoints(cloneRoutePoints(options.connector.points))
    : [];
  const targetPoints = normalizeImportedRoutePoints(cloneRoutePoints(target.gpxRoute.points));

  const mergedRawPoints = appendSegment(
    appendSegment(sourcePoints, connectorPoints),
    targetPoints,
  );
  if (mergedRawPoints.length < 2) return null;

  const mergedPoints = normalizeImportedRoutePoints(mergedRawPoints);
  const sourceDistanceM = routeLengthM(sourcePoints);
  const targetDistanceM = routeLengthM(targetPoints);
  const metrics = buildImportedRouteMetrics(mergedPoints);
  const surfaceMetrics = mergeSurfaceMetrics(
    source,
    sourceDistanceM,
    target,
    targetDistanceM,
    options?.connector,
  );
  const totalDistanceKm = metrics.distanceKm ?? Math.round((routeLengthM(mergedPoints) / 1000) * 10) / 10;
  const timeline = buildMergedTimeline(source, target, mergedPoints, totalDistanceKm);
  const forbiddenZones = mergeForbiddenZones(source.forbiddenZones, target.forbiddenZones);

  const nextItineraries = project.itineraries
    .filter((itinerary) => itinerary.id !== targetId)
    .map((itinerary) => {
      if (itinerary.id !== sourceId) return itinerary;
      const mergedItinerary: Itinerary = structuredClone(itinerary);
      mergedItinerary.gpxRoute = {
        name: mergedItinerary.gpxRoute?.name ?? mergedItinerary.name,
        points: mergedPoints,
        source: 'gpx',
      };
      mergedItinerary.timeline = timeline;
      mergedItinerary.metrics = {
        ...mergedItinerary.metrics,
        ...metrics,
        ...surfaceMetrics,
      };
      mergedItinerary.visible = true;
      mergedItinerary.prediction = null;
      mergedItinerary.forbiddenZones = forbiddenZones;
      delete mergedItinerary.poiFeatures;
      delete mergedItinerary.routeAudit;
      delete mergedItinerary.pendingTraceExtension;
      delete mergedItinerary.pendingRoutePatch;
      delete mergedItinerary.splitRelation;
      if (!forbiddenZones) delete mergedItinerary.forbiddenZones;
      return mergedItinerary;
    });

  return {
    project: {
      ...project,
      itineraries: nextItineraries,
      activeItineraryId: sourceId,
    },
    mergedItineraryId: sourceId,
    removedItineraryId: targetId,
    mergedItineraryName: source.name,
    connectorUsed: connectorPoints.length > 0,
  };
}