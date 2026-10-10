/**
 * Heure de passage le long d'un itinéraire : temps de roulage prédit, pauses
 * planifiées (feuille de route, intervalles, favoris) et heure de départ du
 * Rythme. Partagée par le tri auto des POI et les exports GPS (horaires du
 * jour de passage, horodatage des points d'un parcours FIT).
 */
import type { PredictionResult } from '@/features/fitPredictor';
import { isFootDiscipline } from '@/shared/lib/discipline';
import { timeZoneAtSync } from '@/shared/lib/timeZoneAt';
import { shiftWallClockToTimeZone, wallClockDateToInstantMs } from '@/shared/lib/zonedTime';

import { parseStartReference } from '../../sections/timeline/TimelineTimelineView/utils';
import type { Itinerary } from '../../types';
import { normalizeItineraryRhythmState } from '../project/defaultState';
import { buildPauseAwareSchedule, projectRideElapsedSecondsToScheduledSeconds } from './pauseAwareSchedule';

/** Vitesse de repli quand aucune prédiction n'est disponible (vélo). */
const FALLBACK_SPEED_MS = 18 / 3.6;
/** Repli à pied (trail / course) : 18 km/h n'aurait aucun sens. */
const FALLBACK_FOOT_SPEED_MS = 8 / 3.6;

/**
 * Secondes de roulage pour atteindre `progressM` sur une trace de `routeTotalM`
 * mètres. La prédiction travaille sur sa propre trace rééchantillonnée : on
 * passe par la fraction parcourue pour rester insensible aux écarts de longueur.
 */
export function rideSecondsModel(
  prediction: PredictionResult | null,
  routeTotalM: number,
  fallbackSpeedMs: number = FALLBACK_SPEED_MS,
): (progressM: number) => number {
  const points = prediction?.points ?? [];
  if (points.length < 2 || routeTotalM <= 0) {
    return (progressM) => progressM / fallbackSpeedMs;
  }
  const predictionTotalM = points[points.length - 1]!.distance_m;
  return (progressM) => {
    const d = (progressM / routeTotalM) * predictionTotalM;
    if (d <= points[0]!.distance_m) return points[0]!.elapsed_time_s;
    let lo = 0;
    let hi = points.length - 1;
    if (d >= points[hi]!.distance_m) return points[hi]!.elapsed_time_s;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.distance_m <= d) lo = mid;
      else hi = mid;
    }
    const a = points[lo]!;
    const b = points[hi]!;
    const span = b.distance_m - a.distance_m;
    if (span <= 0) return a.elapsed_time_s;
    return a.elapsed_time_s + ((d - a.distance_m) / span) * (b.elapsed_time_s - a.elapsed_time_s);
  };
}

/**
 * Départ de l'itinéraire : la date / heure du Rythme, sinon demain à l'heure
 * de départ (jour de semaine alors inconnu).
 */
export function resolveScheduleStart(
  rhythm: Itinerary['rhythm'],
  now: Date = new Date(),
): { start: Date; hasRealDate: boolean } {
  const reference = parseStartReference(normalizeItineraryRhythmState(rhythm));
  if (reference.hasRealDate && reference.reference) {
    return { start: reference.reference, hasRealDate: true };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  start.setMinutes(reference.startMinutes);
  return { start, hasRealDate: false };
}

/**
 * Fuseau IANA du lieu de départ : l'heure du Rythme y est une heure murale.
 * null tant que la table des fuseaux n'est pas chargée (preloadTimeZoneTable) :
 * le fuseau du navigateur tient alors lieu de fuseau du départ.
 */
export function departureTimeZone(itinerary: Itinerary): string | null {
  const startRow = itinerary.timeline.find((row) => row.kind === 'start');
  const at = startRow?.lat != null && startRow.lon != null ? startRow : itinerary.gpxRoute?.points[0];
  return at && at.lat != null && at.lon != null ? timeZoneAtSync(at.lon, at.lat) : null;
}

export interface RoutePassageClock {
  /** Secondes depuis le départ, pauses planifiées comprises, au mètre `distanceM` d'une trace de `totalM` mètres. */
  scheduledSecondsAt: (distanceM: number, totalM: number) => number;
  /** Départ (date réelle du Rythme, sinon demain à l'heure de départ). */
  start: Date;
  /** Sans date de départ réelle, le jour de semaine d'un passage est inconnu. */
  hasRealDate: boolean;
  /** false : temps estimés à vitesse constante faute de prédiction. */
  usedPrediction: boolean;
  /**
   * Instant (ms) d'une heure de passage. `start` et les heures qui en
   * découlent sont des heures murales du lieu de départ, construites dans le
   * fuseau du navigateur : un horodatage absolu (FIT) passe par ici.
   */
  instantMs: (wallClock: Date) => number;
  /**
   * Heure murale au lieu (lng, lat) d'un passage, à lire avec les accesseurs
   * locaux : horaires d'ouverture d'un POI passé une frontière de fuseau.
   */
  wallClockAt: (wallClock: Date, lng: number, lat: number) => Date;
}

/**
 * Horloge de passage d'un itinéraire, comme l'agenda : temps de roulage de la
 * prédiction (à défaut une vitesse constante) + pauses planifiées.
 */
export function buildRoutePassageClock(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  now: Date = new Date(),
): RoutePassageClock {
  const usable = prediction && prediction.points.length >= 2 ? prediction : null;
  const stopAnchors = usable ? (buildPauseAwareSchedule(itinerary, usable)?.stopAnchors ?? []) : [];
  const fallbackSpeedMs = isFootDiscipline(itinerary.discipline) ? FALLBACK_FOOT_SPEED_MS : FALLBACK_SPEED_MS;
  const models = new Map<number, (progressM: number) => number>();
  const { start, hasRealDate } = resolveScheduleStart(itinerary.rhythm, now);
  const timeZone = departureTimeZone(itinerary);
  return {
    scheduledSecondsAt: (distanceM, totalM) => {
      let model = models.get(totalM);
      if (!model) {
        model = rideSecondsModel(usable, totalM, fallbackSpeedMs);
        models.set(totalM, model);
      }
      const rideSeconds = model(Math.max(0, Math.min(totalM, distanceM)));
      return projectRideElapsedSecondsToScheduledSeconds(rideSeconds, stopAnchors);
    },
    start,
    hasRealDate,
    usedPrediction: usable != null,
    instantMs: (wallClock) => wallClockDateToInstantMs(wallClock, timeZone),
    wallClockAt: (wallClock, lng, lat) => shiftWallClockToTimeZone(wallClock, timeZone, timeZoneAtSync(lng, lat)),
  };
}
