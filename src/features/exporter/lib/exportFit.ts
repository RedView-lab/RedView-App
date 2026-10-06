import { Profile } from '@garmin/fitsdk';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { isFootDiscipline } from '@/shared/lib/discipline';
import { translateAppText } from '@/shared/i18n/config';
import {
  collectExportAnchors,
  FIT_PRODUCT_ID,
  getExportRoutePoints,
  type ExportAnchor,
  type ExportRoutePoint,
} from './exportHelpers';
import { FitCourseWriter } from './fitCourseWriter';

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

/** FIT stocke les positions en semicercles (sint32) : deg * 2^31 / 180. */
function degreesToSemicircles(degrees: number): number {
  return Math.round(degrees * SEMICIRCLES_PER_DEGREE);
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
      positionLat: degreesToSemicircles(point.lat),
      positionLong: degreesToSemicircles(point.lon),
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
    case 'health':
      // Libellé du profil FIT : « first_aid » faisait échouer tout l'export.
      return 'firstAid';
    case 'transport':
      return 'transport';
    default:
      return 'generic';
  }
}

/**
 * Génère le fichier binaire FIT Course (Garmin) avec points de parcours (CoursePoint) et altitudes.
 */
export function buildItineraryFitCourse(
  itinerary: Itinerary,
  options?: { favoritesOnly?: boolean },
): Uint8Array {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints, options).filter(
    (anchor) => anchor.kind !== 'start' && anchor.kind !== 'end',
  );
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || translateAppText('Itinéraire');
  const createdAt = new Date();
  const encoder = new FitCourseWriter();
  const recordMessages = buildFitRecordMessages(routePoints, createdAt);
  const firstRecord = recordMessages[0]!;
  const lastRecord = recordMessages[recordMessages.length - 1]!;

  encoder.write(Profile.MesgNum.FILE_ID, {
    type: 'course',
    manufacturer: 'development',
    product: FIT_PRODUCT_ID,
    serialNumber: Math.max(1, Math.floor(createdAt.getTime() / 1000)),
    timeCreated: createdAt,
  });

  encoder.write(Profile.MesgNum.COURSE, {
    name: routeName,
    sport: isFootDiscipline(itinerary.discipline) ? 'running' : 'cycling',
  });

  encoder.write(Profile.MesgNum.LAP, {
    startTime: firstRecord.timestamp,
    timestamp: lastRecord.timestamp,
    startPositionLat: firstRecord.positionLat,
    startPositionLong: firstRecord.positionLong,
    endPositionLat: lastRecord.positionLat,
    endPositionLong: lastRecord.positionLong,
    totalDistance: lastRecord.distance,
  });

  encoder.write(Profile.MesgNum.EVENT, {
    timestamp: firstRecord.timestamp,
    event: 'timer',
    eventType: 'start',
  });

  for (const record of recordMessages) {
    encoder.write(Profile.MesgNum.RECORD, record);
  }

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    const linkedRecord = findNearestRecordMessage(anchor.distanceM, recordMessages);
    encoder.write(Profile.MesgNum.COURSE_POINT, {
      messageIndex: index,
      timestamp: linkedRecord.timestamp,
      name: anchor.name,
      type: mapAnchorToFitCoursePointType(anchor),
      positionLat: linkedRecord.positionLat,
      positionLong: linkedRecord.positionLong,
      distance: linkedRecord.distance,
    });
  }

  encoder.write(Profile.MesgNum.EVENT, {
    timestamp: lastRecord.timestamp,
    event: 'timer',
    eventType: 'stopDisableAll',
  });

  return encoder.close();
}
