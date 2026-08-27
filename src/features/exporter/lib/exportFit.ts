import { Encoder, Profile } from '@garmin/fitsdk';
import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  collectExportAnchors,
  FIT_PRODUCT_ID,
  getExportRoutePoints,
  type ExportAnchor,
  type ExportRoutePoint,
} from './exportHelpers';

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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
      timestamp: new Date(createdAtMs + index * 1000),
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

/**
 * Génère le fichier binaire FIT Course (Garmin) avec points de parcours (CoursePoint) et altitudes.
 */
export function buildItineraryFitCourse(itinerary: Itinerary): Uint8Array {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints).filter(
    (anchor) => anchor.kind !== 'start' && anchor.kind !== 'end',
  );
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itineraire';
  const createdAt = new Date();
  const encoder = new Encoder();
  const recordMessages = buildFitRecordMessages(routePoints, createdAt);
  const firstRecord = recordMessages[0]!;
  const lastRecord = recordMessages[recordMessages.length - 1]!;

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
