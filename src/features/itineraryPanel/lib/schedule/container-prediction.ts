import type {
  CyclingCalibration,
  CyclingConfig,
  CyclingGender,
  CyclingRiderSpec,
  CyclingRouteInput,
  PredictionConfig,
  RunPredictionConfig,
} from '@/features/fitPredictor';
import type { FootDiscipline } from '@/shared/lib/discipline';

import type { Itinerary, ItineraryProject, RhythmState } from '../../types';
import { encodeEngineSurface } from '../route-metrics/engineCodes';
import { CUSTOM_PROFILE_LEVEL, isCustomRhythmProfile } from '../rhythm/profile';

const EARTH_RADIUS_M = 6_371_008.8;
const PREDICTION_TARGET_POINT_SPACING_M = 250;
const PREDICTION_MIN_ROUTE_POINTS = 4_000;
const PREDICTION_MAX_ROUTE_POINTS = 8_000;
type PredictionRoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];
type PredictionRoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

// ── Moteur vélo v2 ──────────────────────────────────────────────────────────

/**
 * `originalPoints` (GPX importé non simplifié) remplace `points` s'il décrit le
 * même tracé : mêmes extrémités, longueur à 2,5 % près (la simplification coupe
 * un peu les courbes).
 */
const ORIGINAL_POINTS_LENGTH_TOLERANCE = 0.025;
const ORIGINAL_POINTS_ENDPOINT_TOLERANCE_M = 50;

interface CyclingRoutePointLike {
  lat: number;
  lon: number;
  distanceM?: number;
  elevationM?: number | null;
  surface?: PredictionRoutePoint['surface'];
  roughness?: number;
  wayCode?: number;
}

function toCyclingGender(gender: RhythmState['gender']): CyclingGender {
  return gender === 'female' || gender === 'male' ? gender : 'unspecified';
}

/**
 * Cycliste du moteur v2 : le niveau choisi (préréglage, source unique dans le
 * moteur), ou en profil Personnalisé ce que l'utilisateur a saisi (FTP, poids
 * système, pneus) — qui sert aussi de prior à la calibration .fit.
 */
export function buildCyclingRiderSpec(rhythm: RhythmState): CyclingRiderSpec {
  const gender = toCyclingGender(rhythm.gender);
  if (!isCustomRhythmProfile(rhythm)) {
    return { preset: { level: rhythm.practiceLevel ?? 'debutant', gender } };
  }
  const positive = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  return {
    custom: {
      gender,
      ftp_w: positive(rhythm.ftp),
      mass_kg: positive(rhythm.systemWeightKg),
      tires_mm: positive(rhythm.tiresMm),
    },
  };
}

export function buildCyclingConfig(
  rhythm: RhythmState,
  options: {
    calibration?: CyclingCalibration | null;
    geometry?: CyclingConfig['geometry'];
  } = {},
): CyclingConfig {
  const config: CyclingConfig = {
    rider: options.calibration ? { model: options.calibration.model } : buildCyclingRiderSpec(rhythm),
    geometry: options.geometry ?? 'auto',
  };
  if (options.calibration) {
    config.uncertainty = options.calibration.report.expected_accuracy_pct / 100;
  }
  // Pas d'heure de départ : le moteur ignore les pauses (sommeil compris), son
  // horloge de déplacement ne dit pas l'heure qu'il est.
  return config;
}

/**
 * Tracé complet pour le moteur v2 : points denses (pas de décimation — les
 * virages et les rampes courtes comptent), axe de distance de l'app, altitude
 * manquante = NaN, revêtement / contexte de voie BRouter quand connus.
 * Pour un GPX importé, les points d'origine (non simplifiés) sont préférés
 * s'ils décrivent bien le même tracé.
 */
export function buildCyclingRouteInput(
  itinerary: ItineraryProject['itineraries'][number],
): CyclingRouteInput {
  const route = itinerary.gpxRoute;
  const points = selectDensestPoints(route?.points ?? [], route?.originalPoints);
  const n = points.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const ele = new Float64Array(n);
  const dist = new Float64Array(n);
  const surface = new Uint8Array(n);
  const way = new Uint8Array(n);
  let distanceAxisValid = n > 0;
  let previousDistance = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const point = points[i]!;
    lat[i] = point.lat;
    lon[i] = point.lon;
    ele[i] = Number.isFinite(point.elevationM as number) ? (point.elevationM as number) : Number.NaN;
    const d = point.distanceM;
    if (typeof d === 'number' && Number.isFinite(d) && d >= previousDistance) {
      dist[i] = d;
      previousDistance = d;
    } else {
      distanceAxisValid = false;
    }
    surface[i] = encodeEngineSurface(point.surface, point.roughness ?? 0);
    way[i] = (point.wayCode ?? 0) & 0xff;
  }
  const hasAttributes = surface.some((code) => code !== 0) || way.some((code) => code !== 0);
  return {
    lat,
    lon,
    ele,
    dist: distanceAxisValid ? dist : new Float64Array(0),
    surface: hasAttributes ? surface : new Uint8Array(0),
    way: hasAttributes ? way : new Uint8Array(0),
    headwind: new Float64Array(0),
  };
}

function selectDensestPoints(
  points: readonly CyclingRoutePointLike[],
  originalPoints: readonly CyclingRoutePointLike[] | undefined,
): readonly CyclingRoutePointLike[] {
  if (!originalPoints || originalPoints === points || originalPoints.length <= points.length || points.length < 2) {
    return points;
  }
  const sameEnds =
    haversineM(points[0]!, originalPoints[0]!) < ORIGINAL_POINTS_ENDPOINT_TOLERANCE_M
    && haversineM(points[points.length - 1]!, originalPoints[originalPoints.length - 1]!) < ORIGINAL_POINTS_ENDPOINT_TOLERANCE_M;
  const length = polylineLengthM(points);
  const sameLength = length > 0
    && Math.abs(polylineLengthM(originalPoints) / length - 1) < ORIGINAL_POINTS_LENGTH_TOLERANCE;
  return sameEnds && sameLength ? originalPoints : points;
}

function polylineLengthM(points: readonly CyclingRoutePointLike[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineM(points[i - 1]!, points[i]!);
  return total;
}

/** Géométrie du tracé pour la détection des virages. */
export function resolveCyclingGeometry(
  itinerary: ItineraryProject['itineraries'][number],
): NonNullable<CyclingConfig['geometry']> {
  return itinerary.gpxRoute?.source === 'brouter' ? 'planned' : 'auto';
}

// ── API historique (moteur v1 / scripts d'audit) ────────────────────────────

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

  // Ne surcharger la FTP que si l'utilisateur l'a saisie explicitement comme un
  // nombre positif. Laissée vide (null / undefined / chaîne vide), config.ftp_w
  // reste undefined pour que le moteur de prédiction utilise automatiquement la
  // FTP virtuelle tirée des fichiers .fit !
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

  // Les préréglages de niveau vivent dans le moteur v2 (buildCyclingRiderSpec) :
  // l'API historique ne porte que les saisies du profil Personnalisé.
  if (!custom) return config;

  // Effet de la largeur des pneus sur la résistance au roulement (Crr)
  const tiresMm = rhythm.tiresMm;
  if (typeof tiresMm === 'number' && tiresMm > 0) {
    // Route 25-28 mm : ~0,0045, allroad 32-35 mm : ~0,0050, gravel 40-50 mm : ~0,0058
    config.crr = 0.0035 + (tiresMm * 0.000045);
  }

  return config;
}

/**
 * Configuration du moteur course / trail. Le niveau pilote les valeurs par
 * défaut (allure de référence, seuil de marche, aisance en descente…) ; une VMA
 * ou un temps de course explicites remplacent l'allure de référence du niveau,
 * et les fichiers FIT l'emportent sur les deux.
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
    // XML 1.0 interdit les caractères de contrôle C0 (hors tab, LF, CR), même échappés.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}