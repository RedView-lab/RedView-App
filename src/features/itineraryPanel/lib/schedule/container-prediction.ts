import type { PredictionConfig, RunPredictionConfig } from '@/features/fitPredictor';
import type { FootDiscipline } from '@/shared/lib/discipline';

import type { Itinerary, ItineraryProject, RhythmState } from '../../types';
import { CUSTOM_PROFILE_LEVEL, isCustomRhythmProfile } from '../rhythm/profile';

const EARTH_RADIUS_M = 6_371_008.8;
const PREDICTION_TARGET_POINT_SPACING_M = 250;
const PREDICTION_MIN_ROUTE_POINTS = 4_000;
const PREDICTION_MAX_ROUTE_POINTS = 8_000;
/** Pneus supposés par les profils par défaut (valeur initiale d'un projet). */
const PRESET_TIRES_MM = 35;
type PredictionRoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];
type PredictionRoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

export function buildPredictionConfigFromRhythm(
  rhythm: RhythmState,
  routePoints?: PredictionRoutePoints | null,
): PredictionConfig {
  const config: PredictionConfig = {
    pacing_factor: 1,
    stop_strategy: 'none',
  };

  const maxRoutePoints = resolvePredictionMaxRoutePoints(routePoints);
  if (maxRoutePoints != null) {
    config.max_route_points = maxRoutePoints;
  }

  if (rhythm.gender && rhythm.gender !== 'default') {
    config.gender = rhythm.gender;
  }

  // FTP / poids / pneus ne comptent qu'en profil "Personalisé" ; les profils
  // par défaut s'en tiennent au niveau choisi.
  const custom = isCustomRhythmProfile(rhythm);

  // Only override FTP if explicitly entered as a positive number by the user.
  // When left blank (null / undefined / empty), config.ftp_w remains undefined
  // so the prediction engine automatically uses the virtual FTP derived from the .fit files!
  if (custom && typeof rhythm.ftp === 'number' && rhythm.ftp > 0) {
    config.ftp_w = rhythm.ftp;
  }

  if (
    custom &&
    typeof rhythm.systemWeightKg === 'number' &&
    rhythm.systemWeightKg > 0
  ) {
    config.mass_kg = rhythm.systemWeightKg;
  }

  if (rhythm.startTime) {
    const startTimeH = parseTimeToHourDecimal(rhythm.startTime);
    if (startTimeH !== null) {
      config.start_time_h = startTimeH;
    }
  }

  // Practice level pacing modulation
  config.pacing_factor = resolvePracticeLevelFactor(
    custom ? CUSTOM_PROFILE_LEVEL : rhythm.practiceLevel,
  );

  // Tire width effect on rolling resistance (Crr)
  const tiresMm = custom ? rhythm.tiresMm : PRESET_TIRES_MM;
  if (typeof tiresMm === 'number' && tiresMm > 0) {
    // 25-28mm road: ~0.0045, 32-35mm allroad: ~0.0050, 40-50mm gravel: ~0.0058
    config.crr = 0.0035 + (tiresMm * 0.000045);
  }

  return config;
}

function resolvePracticeLevelFactor(level: string | null | undefined): number {
  const lvl = level?.toLowerCase() ?? '';
  if (lvl.includes('debutant')) return 0.85;
  if (lvl.includes('avance')) return 1.05;
  if (lvl.includes('expert')) return 1.10;
  return 1.0;
}

/**
 * Config of the running / trail engine. The level drives the defaults
 * (reference pace, walk threshold, descent skill…); an explicit VMA or race
 * time replaces the level's reference pace, and FIT files override both.
 */
export function buildRunPredictionConfigFromRhythm(
  rhythm: RhythmState,
  discipline: FootDiscipline,
  routePoints?: PredictionRoutePoints | null,
): RunPredictionConfig {
  const custom = isCustomRhythmProfile(rhythm);
  const config: RunPredictionConfig = {
    discipline,
    level: custom ? CUSTOM_PROFILE_LEVEL : rhythm.practiceLevel ?? 'debutant',
  };

  const maxRoutePoints = resolvePredictionMaxRoutePoints(routePoints);
  if (maxRoutePoints != null) config.max_route_points = maxRoutePoints;

  if (rhythm.gender && rhythm.gender !== 'default') config.gender = rhythm.gender;

  if (rhythm.startTime) {
    const startTimeH = parseTimeToHourDecimal(rhythm.startTime);
    if (startTimeH !== null) config.start_time_h = startTimeH;
  }

  if (custom && typeof rhythm.runWeightKg === 'number' && rhythm.runWeightKg > 0) {
    config.mass_kg = rhythm.runWeightKg;
  }

  // Profil par défaut : le niveau seul fixe l'allure de référence.
  if (custom && rhythm.runReferenceMode === 'chrono') {
    if (
      typeof rhythm.refRaceDistanceM === 'number' && rhythm.refRaceDistanceM > 0
      && typeof rhythm.refRaceTimeS === 'number' && rhythm.refRaceTimeS > 0
    ) {
      config.ref_distance_m = rhythm.refRaceDistanceM;
      config.ref_time_s = rhythm.refRaceTimeS;
    }
  } else if (custom && typeof rhythm.vmaKmh === 'number' && rhythm.vmaKmh > 0) {
    config.vma_kmh = rhythm.vmaKmh;
  }

  if (discipline === 'trail') {
    config.technicality = rhythm.terrainTechnicality ?? 0.5;
  }

  return config;
}

export function buildRouteGpxFile(
  itinerary: ItineraryProject['itineraries'][number],
): File {
  const routeName = escapeXml(itinerary.gpxRoute?.name ?? itinerary.name);
  const points = itinerary.gpxRoute?.points ?? [];
  const trackPoints = points
    .map((point) => {
      const ele = Number.isFinite(point.elevationM as number)
        ? (point.elevationM as number)
        : null;
      if (ele === null) {
        return `      <trkpt lat="${point.lat}" lon="${point.lon}"></trkpt>`;
      }
      return `      <trkpt lat="${point.lat}" lon="${point.lon}"><ele>${ele.toFixed(2)}</ele></trkpt>`;
    })
    .join('\n');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RedView" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    `    <name>${routeName}</name>`,
    '    <trkseg>',
    trackPoints,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ].join('\n');

  return new File([xml], `${slugifyFilename(itinerary.name || 'itinerary')}.gpx`, {
    type: 'application/gpx+xml',
  });
}

export function hasUsableRouteElevation(
  points: NonNullable<Itinerary['gpxRoute']>['points'] | null | undefined,
): boolean {
  if (!points) return false;
  let count = 0;
  for (const point of points) {
    if (Number.isFinite(point.elevationM)) count++;
    if (count >= 2) return true;
  }
  return false;
}

function parseTimeToHourDecimal(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours >= 24 ||
    minutes < 0 ||
    minutes >= 60
  ) {
    return null;
  }
  return hours + minutes / 60;
}

function resolvePredictionMaxRoutePoints(
  routePoints?: PredictionRoutePoints | null,
): number | undefined {
  const totalDistanceM = estimateRouteDistanceM(routePoints);
  if (!(totalDistanceM > 0)) return undefined;

  const estimatedCount = Math.ceil(totalDistanceM / PREDICTION_TARGET_POINT_SPACING_M);
  return Math.max(
    PREDICTION_MIN_ROUTE_POINTS,
    Math.min(PREDICTION_MAX_ROUTE_POINTS, estimatedCount),
  );
}

function estimateRouteDistanceM(
  routePoints?: PredictionRoutePoints | null,
): number {
  if (!routePoints || routePoints.length < 2) return 0;

  const lastDistanceM = routePoints[routePoints.length - 1]?.distanceM;
  if (Number.isFinite(lastDistanceM) && (lastDistanceM as number) > 0) {
    return lastDistanceM as number;
  }

  let totalDistanceM = 0;
  for (let index = 1; index < routePoints.length; index += 1) {
    totalDistanceM += haversineM(routePoints[index - 1], routePoints[index]);
  }
  return totalDistanceM;
}

function haversineM(
  start: Pick<PredictionRoutePoint, 'lat' | 'lon'>,
  end: Pick<PredictionRoutePoint, 'lat' | 'lon'>,
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(end.lat - start.lat);
  const dLon = toRad(end.lon - start.lon);
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function slugifyFilename(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '') || 'itinerary';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}