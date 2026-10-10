import { Profile } from '@garmin/fitsdk';
import { computeAscentDescentFromElevations } from '@/features/itineraryPanel/lib/route-metrics/elevation';
import { buildRoutePassageClock } from '@/features/itineraryPanel/lib/schedule/passageClock';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { isFootDiscipline } from '@/shared/lib/discipline';
import { translateAppText } from '@/shared/i18n/config';
import { coursePointType } from './coursePointTypes';
import {
  collectExportAnchors,
  FIT_PRODUCT_ID,
  getExportRoutePoints,
  type ExportOptions,
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

/**
 * Le parcours annonce ses données : position, distance et temps (les
 * horodatages suivent la prédiction, que le partenaire virtuel rejoue).
 * `processed | valid` est ce qu'écrivent Garmin Connect et Komoot.
 */
const COURSE_CAPABILITIES = 0x01 /* processed */ | 0x02 /* valid */ | 0x04 /* time */ | 0x08 /* distance */ | 0x10 /* position */;

type FitRecord = {
  timestamp: Date;
  positionLat: number;
  positionLong: number;
  distance: number;
  altitude?: number;
};

/**
 * Points du parcours horodatés à l'heure de passage prévue (prédiction +
 * pauses planifiées, comme l'agenda) : le temps du parcours affiché par le
 * compteur et le partenaire virtuel suivent le plan RedView. Secondes
 * entières, jamais décroissantes.
 */
function buildFitRecordMessages(
  routePoints: ExportRoutePoint[],
  startMs: number,
  secondsAt: (distanceM: number) => number,
): FitRecord[] {
  let previousSeconds = 0;
  return routePoints.map((point) => {
    const seconds = Math.max(previousSeconds, Math.round(secondsAt(point.distanceM)));
    previousSeconds = seconds;
    const record: FitRecord = {
      timestamp: new Date(startMs + seconds * 1000),
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

/** Point du parcours le plus proche d'une distance (les distances des points sont croissantes). */
function findNearestRecordMessage(distanceM: number, records: FitRecord[]): FitRecord {
  let lo = 0;
  let hi = records.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid]!.distance < distanceM) lo = mid + 1;
    else hi = mid;
  }
  const after = records[lo]!;
  const before = records[Math.max(0, lo - 1)]!;
  return Math.abs(before.distance - distanceM) <= Math.abs(after.distance - distanceM) ? before : after;
}

/** D+ / D− du parcours : ceux affichés par la synthèse, sinon recalculés sur la trace exportée. */
function resolveAscentDescent(itinerary: Itinerary, routePoints: ExportRoutePoint[]): { ascent?: number; descent?: number } {
  const { ascentM, descentM } = itinerary.metrics ?? {};
  if (Number.isFinite(ascentM) && Number.isFinite(descentM)) {
    return { ascent: Math.round(ascentM as number), descent: Math.round(descentM as number) };
  }
  const elevations = routePoints.flatMap((point) => (point.elevationM == null ? [] : [point.elevationM]));
  if (elevations.length < 2) return {};
  const { ascent, descent } = computeAscentDescentFromElevations(elevations);
  return { ascent: Math.round(ascent), descent: Math.round(descent) };
}

const UINT16_MAX = 0xffff;

/**
 * Génère le fichier binaire FIT Course (Garmin) : trace horodatée selon la
 * prédiction, altitudes, et points de parcours (étapes + POI) nommés selon la
 * convention des ultra-cyclistes (gpsNames.ts).
 */
export function buildItineraryFitCourse(itinerary: Itinerary, options?: ExportOptions): Uint8Array {
  const routePoints = getExportRoutePoints(itinerary);
  const createdAt = options?.now ?? new Date();
  const anchors = collectExportAnchors(itinerary, routePoints, { ...options, now: createdAt }).filter(
    (anchor) => anchor.kind !== 'start' && anchor.kind !== 'end',
  );
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || translateAppText('Itinéraire');
  const totalDistanceM = routePoints[routePoints.length - 1]!.distanceM;

  const clock = buildRoutePassageClock(itinerary, options?.prediction ?? itinerary.prediction, createdAt);
  // Départ du Rythme (sans date : le lendemain à son heure, comme l'agenda) :
  // les heures des points du parcours sont celles de l'agenda.
  const startMs = Math.round(clock.start.getTime() / 1000) * 1000;
  const recordMessages = buildFitRecordMessages(
    routePoints,
    startMs,
    (distanceM) => clock.scheduledSecondsAt(distanceM, totalDistanceM),
  );
  const firstRecord = recordMessages[0]!;
  const lastRecord = recordMessages[recordMessages.length - 1]!;
  const durationS = (lastRecord.timestamp.getTime() - firstRecord.timestamp.getTime()) / 1000;
  const { ascent, descent } = resolveAscentDescent(itinerary, routePoints);

  const encoder = new FitCourseWriter();
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
    capabilities: COURSE_CAPABILITIES,
  });

  encoder.write(Profile.MesgNum.LAP, {
    timestamp: lastRecord.timestamp,
    startTime: firstRecord.timestamp,
    startPositionLat: firstRecord.positionLat,
    startPositionLong: firstRecord.positionLong,
    endPositionLat: lastRecord.positionLat,
    endPositionLong: lastRecord.positionLong,
    totalElapsedTime: durationS,
    totalTimerTime: durationS,
    totalDistance: lastRecord.distance,
    totalAscent: ascent != null ? Math.min(UINT16_MAX, ascent) : undefined,
    totalDescent: descent != null ? Math.min(UINT16_MAX, descent) : undefined,
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
      name: anchor.gpsName,
      type: coursePointType(anchor),
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
