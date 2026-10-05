import { EASE_IN_START_S, FLYOVER_SPEED_STEPS, ORBIT_PERIOD_S } from '../config';
import { computeRailFrame, createRailFrame, type CameraPose } from './cameraPose';
import { RailClock, type CameraRail } from './cameraRail';
import { gaussianSmooth, sampleAt } from './filters';
import type { FlyoverFraming } from './framing';
import { metersPerMercatorUnitAtY, toRadians } from './geo';
import { createTrackPosition, TrackCursor } from './routeTrack';
import { PlaybackTransport } from './transport';

export interface ScreenPoint {
  /** Fractions de l'image : 0 à gauche / en haut, 1 à droite / en bas ; NaN derrière l'œil. */
  x: number;
  y: number;
}

/**
 * Projection perspective d'un point (Mercator + altitude) vu depuis une pose
 * FreeCamera : champ vertical `fovDeg`, image `aspect` (largeur / hauteur).
 */
export function projectToScreen(
  pose: CameraPose,
  fovDeg: number,
  aspect: number,
  x: number,
  y: number,
  altitudeM: number,
  out: ScreenPoint,
): ScreenPoint {
  const mpu = metersPerMercatorUnitAtY(pose.y);
  const east = (x - pose.x) * mpu;
  const north = -(y - pose.y) * mpu;
  const up = altitudeM - pose.altitudeM;
  const b = toRadians(pose.bearingDeg);
  const p = toRadians(pose.pitchDeg);
  const fx = Math.sin(b) * Math.sin(p);
  const fy = Math.cos(b) * Math.sin(p);
  const fz = -Math.cos(p);
  const rx = Math.cos(b);
  const ry = -Math.sin(b);
  // u = r × f (haut de l'image), r horizontal.
  const ux = ry * fz;
  const uy = -rx * fz;
  const uz = rx * fy - ry * fx;
  const depth = east * fx + north * fy + up * fz;
  if (depth <= 0) {
    out.x = Number.NaN;
    out.y = Number.NaN;
    return out;
  }
  const tanHalf = Math.tan(toRadians(fovDeg) / 2);
  const cx = (east * rx + north * ry) / depth;
  const cy = (east * ux + north * uy + up * uz) / depth;
  out.x = 0.5 + (0.5 * cx) / (tanHalf * aspect);
  out.y = 0.5 - (0.5 * cy) / tanHalf;
  return out;
}

/** Écart max de la tête au centre, en fraction de la demi-image, avant que la caméra recule. */
const LATERAL_LIMIT = 0.78;
/** Tête plus bas que cette hauteur (fraction de la demi-image sous le centre) : recul aussi. */
const BOTTOM_LIMIT = 0.78;
const MAX_SCALE = 2.5;
/** Le recul commence aussi tôt avant le besoin (et dure aussi longtemps après). */
const ANTICIPATION_S = 4;
/** Lissage du recul : ni à-coup à l'entrée, ni à la sortie. */
const SMOOTHING_S = 1.5;

export interface FramingScaleRequest {
  rail: CameraRail;
  framing: FlyoverFraming;
  /** Largeur / hauteur de l'image. */
  aspect: number;
  fps: number;
  speedIndex: number;
  exaggeration: number;
}

/** Recul nécessaire pour ramener la tête vue en `screen` dans les marges (≥ 1). */
function requiredScale(screen: ScreenPoint): number {
  if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return MAX_SCALE;
  const lateral = Math.abs(screen.x - 0.5) / 0.5;
  const below = (screen.y - 0.5) / 0.5;
  return Math.min(MAX_SCALE, Math.max(1, lateral / LATERAL_LIMIT, below / BOTTOM_LIMIT));
}

/**
 * Garde de cadrage de la vidéo, pré-calculée comme le reste du rail : la
 * lecture est simulée image par image (même transport, même cap, même orbite
 * que `FlyoverVideoDirector`), on mesure pour chacune le recul qu'il faudrait
 * pour garder la tête dans l'image (demi-tour, lacet vu de côté dans une
 * image étroite), puis on prend le maximum sur ± ANTICIPATION_S et on lisse.
 * La caméra recule donc avant d'en avoir besoin, tient le recul tant qu'il
 * sert et revient en douceur : une seule respiration par passage difficile,
 * jamais le pompage d'une garde qui réagit à l'image précédente.
 * Une valeur par image de lecture (l'arrivée reprend la dernière).
 */
export function framingScaleProfile(request: FramingScaleRequest): Float64Array {
  const { rail, framing, aspect, fps, exaggeration } = request;
  const speedIndex = Math.max(0, Math.min(FLYOVER_SPEED_STEPS.length - 1, request.speedIndex));
  const dt = 1 / fps;
  const transport = new PlaybackTransport(rail.durationS, FLYOVER_SPEED_STEPS[speedIndex]);
  const clock = new RailClock(rail);
  const cursor = new TrackCursor(rail.track);
  const head = createTrackPosition();
  const frame = createRailFrame();
  const screen: ScreenPoint = { x: 0.5, y: 0.5 };
  const headings = rail.heading(speedIndex);
  const needs: number[] = [];
  let orbitTimeS = 0;
  transport.start(EASE_IN_START_S);
  while (!transport.arrived && needs.length < 1e6) {
    transport.step(dt);
    const motion = transport.rate / Math.max(1e-6, transport.multiplierValue);
    orbitTimeS += dt * Math.max(0, Math.min(1, motion));
    const distanceM = clock.distanceAt(transport.playbackTime);
    cursor.locate(distanceM, head);
    computeRailFrame(
      rail,
      {
        distanceM,
        speedMultiplier: transport.multiplierValue,
        headingRad: sampleAt(headings, distanceM / rail.spacingM),
        orbitPhaseRad: (2 * Math.PI * orbitTimeS) / ORBIT_PERIOD_S,
        fovDistanceFactor: framing.distanceFactor,
        targetLeadPerDistance: framing.targetLeadPerDistance,
        exaggeration,
        fallbackTargetAltitudeM: 0,
      },
      frame,
    );
    const headAltitudeM = rail.hasElevation ? head.elevationM * exaggeration : frame.targetAltitudeM;
    projectToScreen(frame.pose, framing.fovDeg, aspect, head.x, head.y, headAltitudeM, screen);
    needs.push(requiredScale(screen));
  }
  const n = Math.max(1, needs.length);
  const window = Math.max(1, Math.round(ANTICIPATION_S * fps));
  const envelope = new Float64Array(n).fill(1);
  for (let i = 0; i < needs.length; i += 1) {
    let max = 1;
    for (let k = Math.max(0, i - window); k <= Math.min(needs.length - 1, i + window); k += 1) max = Math.max(max, needs[k]);
    envelope[i] = max;
  }
  const smoothed = gaussianSmooth(envelope, SMOOTHING_S * fps, 'even');
  for (let i = 0; i < n; i += 1) smoothed[i] = Math.max(1, Math.min(MAX_SCALE, smoothed[i]));
  return smoothed;
}
