import {
  CAMERA_DISTANCE_SPEED_EXPONENT,
  CAMERA_DISTANCE_SPEED_SMOOTHING_S,
  CAMERA_ZOOM_RATE_MAX,
  CENTERLINE_MAX_OFFSET_PER_DISTANCE,
  CENTERLINE_SMOOTHING_PER_DISTANCE,
  ELEVATION_SMOOTHING_PER_DISTANCE,
  FLYOVER_SPEED_STEPS,
  HEADING_CONFIDENCE_FULL,
  HEADING_MAX_RATE_DEG_S,
  HEADING_MIN_RATE_RATIO,
  HEADING_POST_SMOOTHING_S,
  HEADING_SMOOTHING_S,
  HEADING_TARGET_RATE_RATIO,
  INTEREST_GRADE_CAP,
  INTEREST_GRADE_REFERENCE,
  INTEREST_GRADE_WEIGHT,
  INTEREST_TORTUOSITY_CAP,
  INTEREST_TORTUOSITY_WEIGHT,
  INTEREST_WINDOW_PER_DISTANCE,
  ORBIT_AMPLITUDE_DEG,
  ORBIT_INTEREST_FULL,
  ORBIT_INTEREST_START,
  ORBIT_PERIOD_S,
  ORBIT_SMOOTHING_S,
  PITCH_RELIEF_DEG,
  PITCH_RELIEF_FULL,
  PITCH_RELIEF_START,
  PITCH_SMOOTHING_S,
  RAIL_FIXED_POINT_PASSES,
  SPEED_CONTRAST_MAX,
  STRAIGHTNESS_MIN,
  STRAIGHTNESS_WINDOW_PER_DISTANCE,
} from '../config';
import { boxMean, gaussianSmooth, medianFilter, sampleAt, symmetricSlewLimit } from './filters';
import { metersPerMercatorUnitAtY, toRadians, unwrapAngles } from './geo';
import { cameraDistanceForSpeed, playbackDurationForLength, railSpacingForLength } from './laws';
import type { RouteTrack } from './routeTrack';
import { smoothstep } from './springs';
import { cumulativePlaybackTime, solveSpeedProfile } from './speedProfile';

/**
 * Rail caméra : tout le mouvement pré-calculé sur la trace ré-échantillonnée
 * à pas constant. À l'exécution il ne reste qu'à interpoler (O(1)).
 */
export interface CameraRail {
  readonly track: RouteTrack;
  readonly count: number;
  readonly spacingM: number;
  readonly lengthM: number;
  readonly hasElevation: boolean;
  /** Ligne visée lissée (Mercator). */
  readonly centerX: Float64Array;
  readonly centerY: Float64Array;
  /** Profil d'altitude lissé à l'échelle de la caméra (m, non exagéré). */
  readonly elevationM: Float64Array;
  /** Vitesse de lecture au sol à 1× (m/s). */
  readonly speedMps: Float64Array;
  /**
   * Vitesse lissée sur CAMERA_DISTANCE_SPEED_SMOOTHING_S de lecture, qui fixe
   * la distance de la caméra : pas de plongée-remontée à chaque ralentissement bref.
   */
  readonly framingSpeedMps: Float64Array;
  /** Temps de lecture cumulé à 1× (s). */
  readonly playbackTimeS: Float64Array;
  readonly durationS: number;
  readonly targetDurationS: number;
  /** Correction d'inclinaison en relief (≤ 0, degrés). */
  readonly pitchReliefDeg: Float64Array;
  /** Poids du plan hélico (0 → 1) : orbite lente, un peu plus haut, un peu plus plongeant. */
  readonly helicoWeight: Float64Array;
  /** Cap (radians, déroulé) au palier `FLYOVER_SPEED_STEPS[speedIndex]`, calculé à la demande puis gardé. */
  heading(speedIndex: number): Float64Array;
}

interface Resampled {
  count: number;
  spacingM: number;
  x: Float64Array;
  y: Float64Array;
  elevationM: Float64Array;
  /** Mètres par unité Mercator à chaque échantillon. */
  metersPerUnit: Float64Array;
}

function resample(track: RouteTrack): Resampled {
  const lengthM = track.totalM;
  const count = Math.max(2, Math.ceil(lengthM / railSpacingForLength(lengthM)) + 1);
  const spacingM = lengthM / (count - 1);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const rawElevation = new Float64Array(count);
  const metersPerUnit = new Float64Array(count);
  const { distanceM } = track;
  let segment = 0;
  for (let i = 0; i < count; i += 1) {
    const s = i === count - 1 ? lengthM : i * spacingM;
    while (segment < track.count - 2 && distanceM[segment + 1] < s) segment += 1;
    const j = segment + 1;
    const span = distanceM[j] - distanceM[segment];
    const t = span > 0 ? Math.max(0, Math.min(1, (s - distanceM[segment]) / span)) : 0;
    x[i] = track.x[segment] + (track.x[j] - track.x[segment]) * t;
    y[i] = track.y[segment] + (track.y[j] - track.y[segment]) * t;
    rawElevation[i] = track.elevationM[segment] + (track.elevationM[j] - track.elevationM[segment]) * t;
    metersPerUnit[i] = metersPerMercatorUnitAtY(y[i]);
  }
  // Pics isolés (pylône, bâtiment, canopée dans un MNS) hors du profil caméra.
  const radius = Math.max(1, Math.min(4, Math.round(30 / spacingM)));
  return { count, spacingM, x, y, elevationM: medianFilter(rawElevation, radius), metersPerUnit };
}

/** σ (en échantillons) proportionnel à la distance caméra. */
function sigmaFromDistance(distanceM: Float64Array, ratio: number, spacingM: number): Float64Array {
  const sigma = new Float64Array(distanceM.length);
  for (let i = 0; i < sigma.length; i += 1) sigma[i] = (ratio * distanceM[i]) / spacingM;
  return sigma;
}

/** σ (en échantillons) correspondant à `seconds` de lecture à la vitesse locale. */
function sigmaFromTime(speedMps: Float64Array, seconds: number, multiplier: number, spacingM: number): Float64Array {
  const sigma = new Float64Array(speedMps.length);
  for (let i = 0; i < sigma.length; i += 1) sigma[i] = (seconds * multiplier * speedMps[i]) / spacingM;
  return sigma;
}

/**
 * Ligne visée : trace lissée à l'échelle de la caméra (en lacets elle remonte
 * l'axe de la pente pendant que la tête zigzague dans le cadre), écart latéral
 * à la trace borné pour que la tête reste toujours cadrée.
 */
function buildCenterline(
  rs: Resampled,
  distanceM: Float64Array,
  maxOffsetPerDistance: number,
): { x: Float64Array; y: Float64Array } {
  const sigma = sigmaFromDistance(distanceM, CENTERLINE_SMOOTHING_PER_DISTANCE, rs.spacingM);
  const cx = gaussianSmooth(rs.x, sigma);
  const cy = gaussianSmooth(rs.y, sigma);
  for (let i = 0; i < rs.count; i += 1) {
    const ox = cx[i] - rs.x[i];
    const oy = cy[i] - rs.y[i];
    const offsetM = Math.hypot(ox, oy) * rs.metersPerUnit[i];
    const maxM = maxOffsetPerDistance * distanceM[i];
    if (offsetM > maxM) {
      const k = maxM / offsetM;
      cx[i] = rs.x[i] + ox * k;
      cy[i] = rs.y[i] + oy * k;
    }
  }
  // Le bornage peut créer des cassures : un lissage court les efface.
  const finish = sigmaFromDistance(distanceM, CENTERLINE_SMOOTHING_PER_DISTANCE / 5, rs.spacingM);
  return { x: gaussianSmooth(cx, finish), y: gaussianSmooth(cy, finish) };
}

interface Tangents {
  /** Tangente unitaire de la ligne visée (est, nord). */
  east: Float64Array;
  north: Float64Array;
  /** Rectitude à l'échelle de la caméra, dans [0, 1]. */
  straightness: Float64Array;
}

/**
 * Tangentes de la ligne visée (différence centrée sur ± 10 % de la distance
 * caméra) et rectitude : norme de leur moyenne sur ± 1,5 distance caméra
 * (1 en ligne droite, ≈ 0 sur une boucle ou un demi-tour).
 */
function centerlineTangents(cx: Float64Array, cy: Float64Array, distanceM: Float64Array, spacingM: number): Tangents {
  const n = cx.length;
  const east = new Float64Array(n);
  const north = new Float64Array(n);
  let lastEast = 0;
  let lastNorth = 1;
  let firstValid = -1;
  for (let i = 0; i < n; i += 1) {
    const span = Math.max(1, Math.round((0.1 * distanceM[i]) / spacingM));
    const a = Math.max(0, i - span);
    const b = Math.min(n - 1, i + span);
    // Mercator est conforme : y croît vers le sud.
    const dx = cx[b] - cx[a];
    const dy = -(cy[b] - cy[a]);
    const norm = Math.hypot(dx, dy);
    if (norm > 1e-14) {
      lastEast = dx / norm;
      lastNorth = dy / norm;
      if (firstValid < 0) firstValid = i;
    }
    east[i] = lastEast;
    north[i] = lastNorth;
  }
  if (firstValid > 0) {
    east.fill(east[firstValid], 0, firstValid);
    north.fill(north[firstValid], 0, firstValid);
  }
  const window = sigmaFromDistance(distanceM, STRAIGHTNESS_WINDOW_PER_DISTANCE, spacingM);
  const meanEast = boxMean(east, window);
  const meanNorth = boxMean(north, window);
  const straightness = new Float64Array(n);
  for (let i = 0; i < n; i += 1) straightness[i] = Math.min(1, Math.hypot(meanEast[i], meanNorth[i]));
  return { east, north, straightness };
}

/**
 * Cap lissé en vecteur, à phase nulle, sur HEADING_SMOOTHING_S de lecture
 * divisé par le carré de la rectitude : la caméra ne tourne qu'avec la
 * direction d'ensemble du parcours à son échelle.
 */
function smoothedHeading(
  tangents: Tangents,
  speedMps: Float64Array,
  multiplier: number,
  spacingM: number,
): { heading: Float64Array; confidence: Float64Array } {
  const n = speedMps.length;
  const sigma = sigmaFromTime(speedMps, HEADING_SMOOTHING_S, multiplier, spacingM);
  for (let i = 0; i < n; i += 1) {
    const straightness = Math.max(STRAIGHTNESS_MIN, tangents.straightness[i]);
    sigma[i] = Math.min(n, sigma[i] / (straightness * straightness));
  }
  const east = gaussianSmooth(tangents.east, sigma, 'even');
  const north = gaussianSmooth(tangents.north, sigma, 'even');
  const heading = new Float64Array(n);
  const confidence = new Float64Array(n);
  let previous = Math.atan2(tangents.east[0], tangents.north[0]);
  for (let i = 0; i < n; i += 1) {
    confidence[i] = Math.min(1, Math.hypot(east[i], north[i]));
    if (confidence[i] > 1e-9) previous = Math.atan2(east[i], north[i]);
    heading[i] = previous;
  }
  unwrapAngles(heading);
  return { heading, confidence };
}

/**
 * Densité de temps (≥ 1) : sinuosité (longueur / corde − 1) et pente nette
 * mesurées sur une fenêtre de 3 distances caméra, bornées, puis lissées.
 */
function interestDensity(rs: Resampled, distanceM: Float64Array, hasElevation: boolean): Float64Array {
  const n = rs.count;
  const density = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const half = Math.max(1, Math.round((INTEREST_WINDOW_PER_DISTANCE * distanceM[i]) / 2 / rs.spacingM));
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    const arcM = (b - a) * rs.spacingM;
    const chordM = Math.hypot(rs.x[b] - rs.x[a], rs.y[b] - rs.y[a]) * rs.metersPerUnit[i];
    const tortuosity = chordM > 1e-3 ? Math.min(INTEREST_TORTUOSITY_CAP, arcM / chordM - 1) : INTEREST_TORTUOSITY_CAP;
    const grade = hasElevation && arcM > 0 ? Math.abs(rs.elevationM[b] - rs.elevationM[a]) / arcM : 0;
    const value =
      1 +
      INTEREST_TORTUOSITY_WEIGHT * Math.max(0, tortuosity) +
      INTEREST_GRADE_WEIGHT * Math.min(INTEREST_GRADE_CAP, grade / INTEREST_GRADE_REFERENCE);
    density[i] = Math.min(SPEED_CONTRAST_MAX, value);
  }
  const smoothed = gaussianSmooth(density, sigmaFromDistance(distanceM, 1, rs.spacingM), 'even');
  for (let i = 0; i < n; i += 1) smoothed[i] = Math.max(1, Math.min(SPEED_CONTRAST_MAX, smoothed[i]));
  return smoothed;
}

/**
 * Plafond de vitesse : la rotation du cap lissé reste sous
 * HEADING_TARGET_RATE_RATIO × le max. Pondéré par la rectitude² : un
 * demi-tour ou une boucle (rectitude ≈ 0) devient une orbite bornée par le
 * limiteur sans freiner la lecture — le cadrage, lui, ne dépend pas du cap.
 */
function headingRateCaps(heading: Float64Array, straightness: Float64Array, spacingM: number): Float64Array {
  const n = heading.length;
  const caps = new Float64Array(n);
  const targetRate = HEADING_TARGET_RATE_RATIO * toRadians(HEADING_MAX_RATE_DEG_S);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const curvature = (Math.abs(heading[b] - heading[a]) / ((b - a) * spacingM)) * straightness[i] * straightness[i];
    caps[i] = curvature > 1e-9 ? targetRate / curvature : Number.POSITIVE_INFINITY;
  }
  return caps;
}

/**
 * Cap d'un palier de vitesse : cap lissé, rotation bornée à
 * HEADING_MAX_RATE_DEG_S en temps réel (limiteur symétrique) moins la vitesse
 * de l'orbite hélico, réduite quand la direction est incertaine, puis lissage
 * court qui arrondit les reprises (accélération angulaire).
 */
function headingTrack(
  tangents: Tangents,
  speedMps: Float64Array,
  helicoWeight: Float64Array,
  multiplier: number,
  spacingM: number,
): Float64Array {
  const { heading, confidence } = smoothedHeading(tangents, speedMps, multiplier, spacingM);
  const maxRate = toRadians(HEADING_MAX_RATE_DEG_S);
  const orbitRate = (toRadians(ORBIT_AMPLITUDE_DEG) * 2 * Math.PI) / ORBIT_PERIOD_S;
  const last = speedMps.length - 1;
  const limited = symmetricSlewLimit(heading, (i) => {
    const j = Math.min(last, i + 1);
    const segmentSpeed = multiplier * 0.5 * (speedMps[i] + speedMps[j]);
    const certainty = Math.min(confidence[i], confidence[j]) / HEADING_CONFIDENCE_FULL;
    const available = Math.max(0.3 * maxRate, maxRate - orbitRate * Math.max(helicoWeight[i], helicoWeight[j]));
    const rate = available * Math.max(HEADING_MIN_RATE_RATIO, smoothstep(certainty));
    return (rate * spacingM) / Math.max(1e-6, segmentSpeed);
  });
  return gaussianSmooth(limited, sigmaFromTime(speedMps, HEADING_POST_SMOOTHING_S, multiplier, spacingM));
}

/** Correction d'inclinaison selon le relief local (écart-type d'altitude sur ± une distance caméra). */
function reliefPitch(rs: Resampled, distanceM: Float64Array, speedMps: Float64Array, hasElevation: boolean): Float64Array {
  const n = rs.count;
  const pitch = new Float64Array(n);
  if (!hasElevation) return pitch;
  const halfWidth = new Float64Array(n);
  const centered = new Float64Array(n);
  const squared = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    halfWidth[i] = distanceM[i] / rs.spacingM;
    centered[i] = rs.elevationM[i] - rs.elevationM[0];
    squared[i] = centered[i] * centered[i];
  }
  const mean = boxMean(centered, halfWidth);
  const meanSquare = boxMean(squared, halfWidth);
  for (let i = 0; i < n; i += 1) {
    const deviation = Math.sqrt(Math.max(0, meanSquare[i] - mean[i] * mean[i]));
    const relief = (4 * deviation) / distanceM[i];
    pitch[i] = -PITCH_RELIEF_DEG * smoothstep((relief - PITCH_RELIEF_START) / (PITCH_RELIEF_FULL - PITCH_RELIEF_START));
  }
  return gaussianSmooth(pitch, sigmaFromTime(speedMps, PITCH_SMOOTHING_S, 1, rs.spacingM), 'even');
}

/**
 * Poids du plan hélico : intérêt normalisé (sinuosité + pente, 0 sur le plat
 * rectiligne, 1 dans des lacets raides), seuillé puis lissé sur
 * ORBIT_SMOOTHING_S de lecture pour des entrées et sorties douces.
 */
function helicoWeights(density: Float64Array, speedMps: Float64Array, spacingM: number): Float64Array {
  const n = density.length;
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const interest = (density[i] - 1) / (SPEED_CONTRAST_MAX - 1);
    weight[i] = smoothstep((interest - ORBIT_INTEREST_START) / (ORBIT_INTEREST_FULL - ORBIT_INTEREST_START));
  }
  const smoothed = gaussianSmooth(weight, sigmaFromTime(speedMps, ORBIT_SMOOTHING_S, 1, spacingM), 'even');
  for (let i = 0; i < n; i += 1) smoothed[i] = Math.max(0, Math.min(1, smoothed[i]));
  return smoothed;
}

/**
 * Vitesse qui fixe la distance de la caméra : vitesse de lecture lissée
 * (CAMERA_DISTANCE_SPEED_SMOOTHING_S), puis variation bornée en log (limiteur
 * symétrique) pour que la distance — ∝ vitesse^CAMERA_DISTANCE_SPEED_EXPONENT —
 * ne change jamais de plus de CAMERA_ZOOM_RATE_MAX par seconde de lecture.
 */
function framingSpeeds(speedMps: Float64Array, spacingM: number): Float64Array {
  const smoothed = gaussianSmooth(speedMps, sigmaFromTime(speedMps, CAMERA_DISTANCE_SPEED_SMOOTHING_S, 1, spacingM), 'even');
  const logSpeed = new Float64Array(smoothed.length);
  for (let i = 0; i < smoothed.length; i += 1) logSpeed[i] = Math.log(Math.max(1e-3, smoothed[i]));
  const last = speedMps.length - 1;
  const maxLogStep = CAMERA_ZOOM_RATE_MAX / CAMERA_DISTANCE_SPEED_EXPONENT;
  const limited = symmetricSlewLimit(logSpeed, (i) => {
    const segmentSpeed = 0.5 * (speedMps[i] + speedMps[Math.min(last, i + 1)]);
    return (maxLogStep * spacingM) / Math.max(1e-3, segmentSpeed);
  });
  for (let i = 0; i < limited.length; i += 1) limited[i] = Math.exp(limited[i]);
  return limited;
}

function distancesForSpeeds(speedMps: Float64Array): Float64Array {
  const distanceM = new Float64Array(speedMps.length);
  for (let i = 0; i < distanceM.length; i += 1) distanceM[i] = cameraDistanceForSpeed(speedMps[i]);
  return distanceM;
}

/**
 * Construit le rail. La vitesse dépend du cap (plafond de rotation) et de la
 * sinuosité mesurée à l'échelle de la caméra, qui dépend elle-même de la
 * vitesse (la caméra monte quand elle accélère) : itération de point fixe
 * (RAIL_FIXED_POINT_PASSES passes suffisent, l'écart devient négligeable).
 * `centerlineMaxOffsetPerDistance` vient du cadrage (`engine/framing.ts`) :
 * plus serré en portrait, où l'image est étroite.
 */
export function buildCameraRail(
  track: RouteTrack,
  targetDurationS = playbackDurationForLength(track.totalM),
  centerlineMaxOffsetPerDistance = CENTERLINE_MAX_OFFSET_PER_DISTANCE,
): CameraRail {
  const rs = resample(track);
  const { count, spacingM } = rs;
  let speedMps: Float64Array = new Float64Array(count).fill(track.totalM / targetDurationS);
  for (let pass = 0; pass < RAIL_FIXED_POINT_PASSES; pass += 1) {
    const distanceM = distancesForSpeeds(speedMps);
    const centerline = buildCenterline(rs, distanceM, centerlineMaxOffsetPerDistance);
    const tangents = centerlineTangents(centerline.x, centerline.y, distanceM, spacingM);
    const { heading } = smoothedHeading(tangents, speedMps, 1, spacingM);
    const density = interestDensity(rs, distanceM, track.hasElevation);
    speedMps = solveSpeedProfile(density, headingRateCaps(heading, tangents.straightness, spacingM), spacingM, targetDurationS).speedMps;
  }

  const distanceM = distancesForSpeeds(speedMps);
  const centerline = buildCenterline(rs, distanceM, centerlineMaxOffsetPerDistance);
  const tangents = centerlineTangents(centerline.x, centerline.y, distanceM, spacingM);
  const elevationM = track.hasElevation
    ? gaussianSmooth(rs.elevationM, sigmaFromDistance(distanceM, ELEVATION_SMOOTHING_PER_DISTANCE, spacingM))
    : new Float64Array(count);
  const playbackTimeS = cumulativePlaybackTime(speedMps, spacingM);
  const headings: Array<Float64Array | undefined> = new Array(FLYOVER_SPEED_STEPS.length);
  const finalSpeed = speedMps;
  const helicoWeight = helicoWeights(interestDensity(rs, distanceM, track.hasElevation), finalSpeed, spacingM);

  return {
    track,
    count,
    spacingM,
    lengthM: track.totalM,
    hasElevation: track.hasElevation,
    centerX: centerline.x,
    centerY: centerline.y,
    elevationM,
    speedMps: finalSpeed,
    framingSpeedMps: framingSpeeds(finalSpeed, spacingM),
    playbackTimeS,
    durationS: playbackTimeS[count - 1],
    targetDurationS,
    pitchReliefDeg: reliefPitch(rs, distanceM, finalSpeed, track.hasElevation),
    helicoWeight,
    heading(speedIndex) {
      const index = Math.max(0, Math.min(FLYOVER_SPEED_STEPS.length - 1, speedIndex));
      let cached = headings[index];
      if (!cached) {
        cached = headingTrack(tangents, finalSpeed, helicoWeight, FLYOVER_SPEED_STEPS[index], spacingM);
        headings[index] = cached;
      }
      return cached;
    },
  };
}

/** Position de lecture (m) pour un temps de lecture à 1× (s). Recherche gardée en cache. */
export class RailClock {
  private readonly rail: CameraRail;
  private index = 0;

  constructor(rail: CameraRail) {
    this.rail = rail;
  }

  distanceAt(playbackTimeS: number): number {
    const { playbackTimeS: tau, count, spacingM, lengthM } = this.rail;
    if (playbackTimeS <= 0) return 0;
    if (playbackTimeS >= tau[count - 1]) return lengthM;
    let i = this.index;
    if (playbackTimeS < tau[i] || playbackTimeS > tau[i + 1]) {
      if (playbackTimeS > tau[i + 1] && i + 2 < count && playbackTimeS <= tau[i + 2]) {
        i += 1;
      } else {
        let lo = 0;
        let hi = count - 1;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >> 1;
          if (tau[mid] <= playbackTimeS) lo = mid;
          else hi = mid;
        }
        i = lo;
      }
      this.index = i;
    }
    const span = tau[i + 1] - tau[i];
    const t = span > 0 ? (playbackTimeS - tau[i]) / span : 0;
    return Math.min(lengthM, (i + t) * spacingM);
  }

  /** Temps de lecture à 1× correspondant à une distance (seek). */
  timeAt(distanceM: number): number {
    const { playbackTimeS, spacingM } = this.rail;
    return sampleAt(playbackTimeS, Math.max(0, distanceM) / spacingM);
  }
}
