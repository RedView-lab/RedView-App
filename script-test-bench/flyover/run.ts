/**
 * RedView Test-Bench : moteur du flyover 3D (pur, sans navigateur).
 *
 * Construit le rail caméra sur des parcours types (ligne droite, courbes,
 * lacets synthétiques, Alpe d'Huez et Galibier réels, aller-retour, piste ×55,
 * 600 m, 1 200 km, trace bruitée et incomplète) puis simule la lecture image
 * par image comme `FlyoverController` (transport, cap, distance, garde-relief
 * sur le profil de la trace) à 30, 60 et 144 i/s.
 *
 * Critères durs (code de sortie ≠ 0) :
 *  - rail : durée à ±2 % de la cible quand aucun plafond ne l'empêche ;
 *  - lecture : progression monotone, arrêt exactement sur la fin ;
 *  - confort : rotation de cap ≤ 14°/s (+5 %) orbite hélico comprise,
 *    accélération angulaire bornée ;
 *  - cadrage : la tête reste dans la zone utile de l'image (projection
 *    perspective réelle : FOV vertical de la lecture, 16:9), œil au-dessus du sol ;
 *  - vidéo 9:16 (cadrage portrait, garde de cadrage, 30 i/s) : tête dans la
 *    zone utile du portrait, sous le centre en moyenne, mêmes bornes de rotation ;
 *  - inclinaison dans [45°, 70°] ;
 *  - indépendance au framerate : mêmes poses (±1 % de la distance, ±0,5°) à 30/60/144 i/s ;
 *  - changement de vitesse en cours : aucun saut de cap ;
 *  - zoom : la distance caméra ne varie jamais de plus de ZOOM_RATE_LIMIT par
 *    seconde (16:9 et 9:16) — pas de plongée-remontée à chaque virage ;
 *  - montage vidéo (16:9 et 9:16, 30 i/s, carte simulée) : nombre d'images
 *    annoncé = images produites, plans dans l'ordre, caméra continue d'une
 *    image à l'autre (ouverture → approche → rail → vue d'ensemble), trace
 *    complète au début et à la fin, progression monotone pendant la lecture.
 * Mesures : temps de construction du rail, coût par image.
 *
 * Usage : npm run bench:flyover [-- --only alpe-dhuez,lacets]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  ARRIVAL_BRAKING_S,
  EASE_IN_START_S,
  FLYOVER_DEFAULT_SPEED_INDEX,
  FLYOVER_FOV_DEG,
  FLYOVER_SPEED_STEPS,
  GUARD_FALL_HALF_LIFE_S,
  GUARD_RISE_HALF_LIFE_S,
  HEADING_MAX_RATE_DEG_S,
  ORBIT_AMPLITUDE_DEG,
  ORBIT_PERIOD_S,
  PITCH_MAX_DEG,
  PITCH_MIN_DEG,
} from '../../src/features/centerPanel/flyover/config.ts';
import { buildCameraRail, RailClock, type CameraRail } from '../../src/features/centerPanel/flyover/engine/cameraRail.ts';
import {
  computeRailFrame,
  createRailFrame,
  liftCameraPose,
  requiredLift,
  type GroundSampler,
} from '../../src/features/centerPanel/flyover/engine/cameraPose.ts';
import { sampleAt } from '../../src/features/centerPanel/flyover/engine/filters.ts';
import {
  haversineM,
  metersPerMercatorUnitAtY,
  toRadians,
  wrapPi,
} from '../../src/features/centerPanel/flyover/engine/geo.ts';
import {
  buildRouteTrack,
  createTrackPosition,
  TrackCursor,
  type FlyoverRoutePoint,
} from '../../src/features/centerPanel/flyover/engine/routeTrack.ts';
import { landscapeFraming, portraitFraming, type FlyoverFraming } from '../../src/features/centerPanel/flyover/engine/framing.ts';
import { headingBlendDurationS } from '../../src/features/centerPanel/flyover/engine/laws.ts';
import { framingScaleProfile, projectToScreen } from '../../src/features/centerPanel/flyover/engine/screenGuard.ts';
import { approachExponential, smootherstep } from '../../src/features/centerPanel/flyover/engine/springs.ts';
import { PlaybackTransport } from '../../src/features/centerPanel/flyover/engine/transport.ts';
import { zoomForCameraDistance } from '../../src/features/centerPanel/flyover/engine/approach.ts';
import { EARTH_CIRCUMFERENCE_M, latFromMercatorY, toDegrees } from '../../src/features/centerPanel/flyover/engine/geo.ts';
import type { CameraPose } from '../../src/features/centerPanel/flyover/engine/cameraPose.ts';
import { FlyoverVideoDirector, type DirectorMap, type VideoSegment } from '../../src/features/centerPanel/flyover/video/director.ts';
import type { MapView } from '../../src/features/centerPanel/flyover/video/flight.ts';
import { BenchmarkSuite } from '../core/harness.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
interface View {
  framing: FlyoverFraming;
  /** Largeur / hauteur de l'image. */
  aspect: number;
  /** Recul de cadrage pré-calculé (`framingScaleProfile`), comme l'export vidéo. */
  screenGuard: boolean;
}
const LANDSCAPE: View = { framing: landscapeFraming(FLYOVER_FOV_DEG), aspect: 16 / 9, screenGuard: false };
const PORTRAIT: View = { framing: portraitFraming(), aspect: 9 / 16, screenGuard: true };
/** Zone utile : la tête ne doit jamais sortir de ce cadre (fractions de l'image). */
const SAFE_X: [number, number] = [0.06, 0.94];
const SAFE_Y: [number, number] = [0.3, 0.97];
/** Portrait : image étroite, et le bas est couvert par les légendes des réseaux sociaux. */
const PORTRAIT_SAFE_X: [number, number] = [0.08, 0.92];
const PORTRAIT_SAFE_Y: [number, number] = [0.4, 0.9];
/**
 * Hauteur médiane de la tête en portrait : jamais au-dessus du centre (≈ 0,75 en
 * ligne droite ; près du centre en lacets et sur une piste, où la caméra suit
 * l'axe de la montée ou tient son cap pendant que la tête tourne).
 */
const PORTRAIT_MEDIAN_Y: [number, number] = [0.5, 0.8];
const HEADING_RATE_LIMIT = HEADING_MAX_RATE_DEG_S * 1.05;
const HEADING_ACCEL_LIMIT_DEG_S2 = 60;
/** Variation max de la distance caméra (fraction par seconde, en log). */
const ZOOM_RATE_LIMIT = 0.08;

/** Variation max de la distance caméra d'une image à l'autre, ramenée à la seconde. */
function zoomRate(frames: SimFrame[], fps: number): number {
  let rate = 0;
  for (let i = 1; i < frames.length; i += 1) rate = Math.max(rate, Math.abs(Math.log(frames[i].distance / frames[i - 1].distance)) * fps);
  return rate;
}
const MAX_SIM_S = 900;

/* ── Parcours ─────────────────────────────────────────────────────────── */

interface Fixture {
  id: string;
  label: string;
  points: FlyoverRoutePoint[];
}

function walk(start: { lat: number; lon: number }, steps: Array<{ headingDeg: number; meters: number; climb?: number }>, spacingM = 10): FlyoverRoutePoint[] {
  const points: FlyoverRoutePoint[] = [];
  let { lat, lon } = start;
  let elevation = 400;
  points.push({ lat, lon, elevationM: elevation });
  for (const step of steps) {
    const n = Math.max(1, Math.round(step.meters / spacingM));
    const rad = toRadians(step.headingDeg);
    for (let i = 0; i < n; i += 1) {
      const d = step.meters / n;
      lat += (d * Math.cos(rad)) / 111_320;
      lon += (d * Math.sin(rad)) / (111_320 * Math.cos(toRadians(lat)));
      elevation += (step.climb ?? 0) * d;
      points.push({ lat, lon, elevationM: elevation });
    }
  }
  return points;
}

/** Virage progressif : `turnDeg` répartis sur `meters`. */
function arc(headingDeg: number, turnDeg: number, meters: number, climb = 0, pieces = 24) {
  return Array.from({ length: pieces }, (_, i) => ({
    headingDeg: headingDeg + (turnDeg * (i + 0.5)) / pieces,
    meters: meters / pieces,
    climb,
  }));
}

function straightRoute(): FlyoverRoutePoint[] {
  return walk({ lat: 47, lon: 2 }, [{ headingDeg: 35, meters: 20_000, climb: 0.002 }], 25);
}

function curvesRoute(): FlyoverRoutePoint[] {
  const steps = [];
  let heading = 80;
  for (let k = 0; k < 40; k += 1) {
    const turn = 50 * Math.sin(k * 1.7);
    steps.push(...arc(heading, turn, 2000, 0.01 * Math.sin(k)));
    heading += turn;
  }
  return walk({ lat: 46.5, lon: 3 }, steps, 20);
}

function hairpinsRoute(): FlyoverRoutePoint[] {
  const steps = [{ headingDeg: 90, meters: 5000, climb: 0.01 }];
  let heading = 20;
  for (let k = 0; k < 20; k += 1) {
    steps.push({ headingDeg: heading, meters: 260, climb: 0.08 });
    const turn = k % 2 === 0 ? 160 : -160;
    steps.push(...arc(heading, turn, 45, 0.08, 12));
    heading += turn;
  }
  steps.push({ headingDeg: heading, meters: 2000, climb: 0.05 });
  return walk({ lat: 45.05, lon: 6.03 }, steps, 5);
}

function outAndBackRoute(): FlyoverRoutePoint[] {
  const out = walk({ lat: 44, lon: 5 }, [...arc(10, 30, 8000, 0.03), ...arc(40, -20, 7000, 0.04)], 15);
  return [...out, ...out.slice(0, -1).reverse()];
}

function trackLapsRoute(): FlyoverRoutePoint[] {
  const lap: FlyoverRoutePoint[] = [];
  const cLat = 48.8;
  const cLon = 2.3;
  for (let i = 0; i < 80; i += 1) {
    const t = (i / 80) * 2 * Math.PI;
    lap.push({ lat: cLat + (60 * Math.sin(t)) / 111_320, lon: cLon + (110 * Math.cos(t)) / 73_000, elevationM: 35 });
  }
  return Array.from({ length: 55 }, () => lap).flat();
}

function tinyRoute(): FlyoverRoutePoint[] {
  return walk({ lat: 45.5, lon: 4.8 }, [...arc(0, 90, 600, 0.02)], 5);
}

function longRoute(): FlyoverRoutePoint[] {
  const steps = [];
  for (let k = 0; k < 600; k += 1) {
    steps.push(...arc(300 + 40 * Math.sin(k / 23), 25 * Math.sin(k * 0.9), 2000, 0.012 * Math.sin(k / 7), 8));
  }
  return walk({ lat: 45.9, lon: 6.9 }, steps, 40);
}

/** GPS bruité, pics d'altitude (MNS : arbres, pylônes), trous d'altitude, doublons. */
function noisyRoute(): FlyoverRoutePoint[] {
  const base = hairpinsRoute();
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const noisy: FlyoverRoutePoint[] = [];
  base.forEach((point, i) => {
    const jitter = () => (random() - 0.5) * 2 * (4 / 111_320);
    const elevation = i % 97 === 0 ? (point.elevationM as number) + 35 : i % 53 < 6 ? null : point.elevationM;
    const next = { lat: point.lat + jitter(), lon: point.lon + jitter(), elevationM: elevation };
    noisy.push(next);
    if (i % 41 === 0) noisy.push({ ...next });
  });
  return noisy;
}

function loadFixture(name: string): FlyoverRoutePoint[] {
  const file = path.join(ROOT, 'script-test-bench', 'flyover', 'fixtures', `${name}.json`);
  const { points } = JSON.parse(fs.readFileSync(file, 'utf8')) as { points: [number, number, number][] };
  return points.map(([lon, lat, elevationM]) => ({ lat, lon, elevationM }));
}

const FIXTURES: Array<() => Fixture> = [
  () => ({ id: 'ligne-droite', label: 'Ligne droite 20 km', points: straightRoute() }),
  () => ({ id: 'courbes', label: 'Courbes 80 km', points: curvesRoute() }),
  () => ({ id: 'lacets', label: 'Lacets synthétiques ×20 (8 %)', points: hairpinsRoute() }),
  () => ({ id: 'alpe-dhuez', label: "Alpe d'Huez (réel)", points: loadFixture('alpe-dhuez') }),
  () => ({ id: 'galibier', label: 'Galibier (réel)', points: loadFixture('galibier') }),
  () => ({ id: 'aller-retour', label: 'Aller-retour 30 km', points: outAndBackRoute() }),
  () => ({ id: 'piste', label: 'Piste 400 m ×55', points: trackLapsRoute() }),
  () => ({ id: 'mini', label: 'Mini 600 m', points: tinyRoute() }),
  () => ({ id: 'long', label: '1 200 km', points: longRoute() }),
  () => ({ id: 'bruite', label: 'Trace bruitée et incomplète', points: noisyRoute() }),
];

function cumulativeDistances(points: FlyoverRoutePoint[]): number[] {
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push(distances[i - 1] + haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon));
  }
  return distances;
}

/* ── Relief : seul relief connu hors navigateur = le profil de la trace ── */

function profileGround(rail: CameraRail): GroundSampler {
  const cell = 150;
  const grid = new Map<string, number[]>();
  const mpu = metersPerMercatorUnitAtY(rail.centerY[0]);
  const { x, y, elevationM } = rail.track;
  const key = (gx: number, gy: number) => `${gx}:${gy}`;
  for (let i = 0; i < rail.track.count; i += 1) {
    const k = key(Math.floor((x[i] * mpu) / cell), Math.floor((y[i] * mpu) / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  return (px, py) => {
    const gx = Math.floor((px * mpu) / cell);
    const gy = Math.floor((py * mpu) / cell);
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const i of grid.get(key(gx + dx, gy + dy)) ?? []) {
          const d = (x[i] - px) ** 2 + (y[i] - py) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best >= 0 && rail.track.hasElevation ? elevationM[best] : null;
  };
}

/* ── Simulation ───────────────────────────────────────────────────────── */

interface SimFrame {
  t: number;
  s: number;
  eyeX: number;
  eyeY: number;
  eyeAlt: number;
  pitch: number;
  bearing: number;
  distance: number;
  screenX: number;
  screenY: number;
  clearance: number | null;
  /** Décalage d'orbite hélico appliqué (degrés). */
  orbitDeg: number;
}

interface SimOptions {
  fps: number;
  speedIndex: number;
  view?: View;
  /** Changement de palier en cours de lecture : [temps (s), nouveau palier]. */
  speedChange?: [number, number];
}

function simulate(rail: CameraRail, ground: GroundSampler, options: SimOptions): { frames: SimFrame[]; endS: number; frameCostUs: number } {
  const transport = new PlaybackTransport(rail.durationS, FLYOVER_SPEED_STEPS[options.speedIndex]);
  const clock = new RailClock(rail);
  const cursor = new TrackCursor(rail.track);
  const head = createTrackPosition();
  const frame = createRailFrame();
  const dt = 1 / options.fps;
  const frames: SimFrame[] = [];
  const view = options.view ?? LANDSCAPE;
  const guardScale = view.screenGuard
    ? framingScaleProfile({ rail, framing: view.framing, aspect: view.aspect, fps: options.fps, speedIndex: options.speedIndex, exaggeration: 1 })
    : null;
  const screen = { x: 0.5, y: 0.5 };
  let track = options.speedIndex;
  let headingOffset = 0;
  let blendS = Number.POSITIVE_INFINITY;
  let blendDurationS = 0;
  let lift = 0;
  let orbitTime = 0;
  let cost = 0;
  transport.start(EASE_IN_START_S);
  let t = 0;
  while (!transport.arrived && t < MAX_SIM_S) {
    if (options.speedChange && t < options.speedChange[0] && t + dt >= options.speedChange[0]) {
      const [, next] = options.speedChange;
      const s = clock.distanceAt(transport.playbackTime);
      const current =
        sampleAt(rail.heading(track), s / rail.spacingM) +
        (blendS < blendDurationS ? headingOffset * (1 - smootherstep(blendS / blendDurationS)) : 0);
      track = next;
      headingOffset = wrapPi(current - sampleAt(rail.heading(track), s / rail.spacingM));
      blendS = 0;
      blendDurationS = headingBlendDurationS(headingOffset);
      transport.setMultiplier(FLYOVER_SPEED_STEPS[next]);
    }
    t += dt;
    const start = performance.now();
    transport.step(dt);
    orbitTime += dt * Math.max(0, Math.min(1, transport.rate / Math.max(1e-6, transport.multiplierValue)));
    const s = clock.distanceAt(transport.playbackTime);
    cursor.locate(s, head);
    let heading = sampleAt(rail.heading(track), s / rail.spacingM);
    if (blendS < blendDurationS) {
      blendS += dt;
      heading += headingOffset * (1 - smootherstep(blendS / blendDurationS));
    }
    const orbitPhaseRad = (2 * Math.PI * orbitTime) / ORBIT_PERIOD_S;
    computeRailFrame(
      rail,
      {
        distanceM: s,
        speedMultiplier: transport.multiplierValue,
        headingRad: heading,
        orbitPhaseRad,
        fovDistanceFactor: view.framing.distanceFactor * (guardScale ? guardScale[Math.min(guardScale.length - 1, frames.length)] : 1),
        targetLeadPerDistance: view.framing.targetLeadPerDistance,
        exaggeration: 1,
        fallbackTargetAltitudeM: 0,
      },
      frame,
    );
    const headAlt = rail.hasElevation ? head.elevationM : 0;
    const behind = Math.max(0, s - frame.horizontalM) / rail.spacingM;
    const eyeFallback = rail.hasElevation ? Math.max(sampleAt(rail.elevationM, behind), head.elevationM) : 0;
    const needed = requiredLift(frame, head.x, head.y, headAlt, ground, eyeFallback);
    lift = approachExponential(lift, needed, needed > lift ? GUARD_RISE_HALF_LIFE_S : GUARD_FALL_HALF_LIFE_S, dt);
    liftCameraPose(frame, lift);
    cost += performance.now() - start;

    const sim: SimFrame = {
      t,
      s,
      eyeX: frame.pose.x,
      eyeY: frame.pose.y,
      eyeAlt: frame.pose.altitudeM,
      pitch: frame.pose.pitchDeg,
      bearing: frame.pose.bearingDeg,
      distance: frame.distanceM,
      screenX: 0,
      screenY: 0,
      clearance: null,
      orbitDeg: sampleAt(rail.helicoWeight, s / rail.spacingM) * ORBIT_AMPLITUDE_DEG * Math.sin(orbitPhaseRad),
    };
    projectToScreen(frame.pose, view.framing.fovDeg, view.aspect, head.x, head.y, headAlt, screen);
    sim.screenX = screen.x;
    sim.screenY = screen.y;
    const g = ground(frame.pose.x, frame.pose.y);
    sim.clearance = g == null ? null : frame.pose.altitudeM - g;
    frames.push(sim);
  }
  return { frames, endS: clock.distanceAt(transport.playbackTime), frameCostUs: (cost / Math.max(1, frames.length)) * 1000 };
}

/* ── Analyse ──────────────────────────────────────────────────────────── */

interface Check {
  fixture: string;
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(fixture: string, name: string, ok: boolean, detail = ''): void {
  checks.push({ fixture, name, ok, detail });
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function headingStats(frames: SimFrame[], dt: number): { maxRate: number; p99Rate: number; maxAccel: number; p99Accel: number } {
  const rates: number[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    rates.push((wrapPi(toRadians(frames[i].bearing - frames[i - 1].bearing)) * 180) / Math.PI / dt);
  }
  const accels: number[] = [];
  for (let i = 1; i < rates.length; i += 1) accels.push(Math.abs(rates[i] - rates[i - 1]) / dt);
  const absRates = rates.map(Math.abs).sort((a, b) => a - b);
  accels.sort((a, b) => a - b);
  const pick = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  return { maxRate: absRates.at(-1) ?? 0, p99Rate: pick(absRates, 0.99), maxAccel: accels.at(-1) ?? 0, p99Accel: pick(accels, 0.99) };
}

/* ── Montage vidéo (carte simulée) ────────────────────────────────────── */

const VIDEO_SEGMENT_ORDER: VideoSegment[] = ['intro', 'approach', 'play', 'arrival', 'overview', 'outro'];

/** Distance œil → centre d'une vue Mapbox (inverse de `zoomForCameraDistance`). */
function viewDistanceM(view: MapView, heightPx: number, fovDeg: number): number {
  const cameraToCenterPx = (0.5 * heightPx) / Math.tan(toRadians(fovDeg) / 2);
  const metersPerWorld = EARTH_CIRCUMFERENCE_M * Math.cos(toRadians(latFromMercatorY(view.y)));
  return (cameraToCenterPx * metersPerWorld) / (512 * 2 ** view.zoom);
}

function poseFromView(view: MapView, heightPx: number, fovDeg: number, groundM: number): CameraPose {
  const d = viewDistanceM(view, heightPx, fovDeg);
  const b = toRadians(view.bearingDeg);
  const p = toRadians(view.pitchDeg);
  const unitsPerM = 1 / metersPerMercatorUnitAtY(view.y);
  return {
    x: view.x - Math.sin(b) * d * Math.sin(p) * unitsPerM,
    y: view.y + Math.cos(b) * d * Math.sin(p) * unitsPerM,
    altitudeM: groundM + d * Math.cos(p),
    pitchDeg: view.pitchDeg,
    bearingDeg: view.bearingDeg,
  };
}

/** Vue d'une pose : centre = rayon de visée ∩ sol, sol lu au centre (comme Mapbox), par itération. */
function viewFromPose(pose: CameraPose, heightPx: number, fovDeg: number, groundAt: (x: number, y: number) => number): MapView {
  const p = toRadians(Math.min(85, pose.pitchDeg));
  const b = toRadians(pose.bearingDeg);
  const unitsPerM = 1 / metersPerMercatorUnitAtY(pose.y);
  let groundM = groundAt(pose.x, pose.y);
  let x = pose.x;
  let y = pose.y;
  let height = 1;
  for (let pass = 0; pass < 4; pass += 1) {
    height = Math.max(1, pose.altitudeM - groundM);
    const horizontal = height * Math.tan(p);
    x = pose.x + Math.sin(b) * horizontal * unitsPerM;
    y = pose.y - Math.cos(b) * horizontal * unitsPerM;
    groundM = groundAt(x, y);
  }
  return {
    x,
    y,
    zoom: zoomForCameraDistance(height / Math.cos(p), latFromMercatorY(y), heightPx, fovDeg),
    pitchDeg: pose.pitchDeg,
    bearingDeg: pose.bearingDeg,
  };
}

/**
 * Carte simulée : relief du garde = profil de la trace ; vue d'ensemble =
 * emprise de la trace ; conversions vue ↔ pose sur un sol plat à l'altitude
 * moyenne (Mapbox lit un relief continu sous le centre, le profil de la trace
 * n'en donne qu'au voisinage du tracé).
 */
function simulatedDirectorMap(rail: CameraRail, viewport: { width: number; height: number }, fovDeg: number) {
  const ground = profileGround(rail);
  let sum = 0;
  for (let i = 0; i < rail.track.count; i += 1) sum += rail.track.elevationM[i];
  const meanElevation = rail.track.hasElevation ? sum / rail.track.count : 0;
  const groundAt = () => meanElevation;
  let last: { view: MapView | null; pose: CameraPose | null } = { view: null, pose: null };
  const { x, y } = rail.track;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < rail.track.count; i += 1) {
    minX = Math.min(minX, x[i]);
    maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]);
    maxY = Math.max(maxY, y[i]);
  }
  const map: DirectorMap = {
    viewport,
    ground,
    exaggeration: 1,
    overviewView: (bearingDeg) => {
      const extent = Math.max(maxX - minX, maxY - minY, 1e-7) * 1.3;
      const zoom = Math.log2(Math.min(viewport.width, viewport.height) / (512 * extent));
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, pitchDeg: 40, bearingDeg };
    },
    currentView: () => (last.view ? { ...last.view } : viewFromPose(last.pose as CameraPose, viewport.height, fovDeg, groundAt)),
    currentPose: (out) => {
      const pose = last.pose ?? poseFromView(last.view as MapView, viewport.height, fovDeg, meanElevation);
      return Object.assign(out, pose);
    },
  };
  return {
    map,
    applied(camera: { kind: 'view'; view: MapView } | { kind: 'pose'; pose: CameraPose }): CameraPose {
      last = camera.kind === 'view' ? { view: { ...camera.view }, pose: null } : { view: null, pose: { ...camera.pose } };
      return camera.kind === 'view' ? poseFromView(camera.view, viewport.height, fovDeg, meanElevation) : { ...camera.pose };
    },
    /** Distance œil → point visé (m). */
    distanceOf(pose: CameraPose): number {
      return viewDistanceM(viewFromPose(pose, viewport.height, fovDeg, groundAt), viewport.height, fovDeg);
    },
  };
}

function checkVideoMontage(fixtureId: string, track: NonNullable<ReturnType<typeof buildRouteTrack>>): void {
  for (const view of [LANDSCAPE, PORTRAIT]) {
    const tag = view === PORTRAIT ? '9:16' : '16:9';
    const viewport = view === PORTRAIT ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
    const rail = buildCameraRail(track, undefined, view.framing.centerlineMaxOffsetPerDistance);
    const sim = simulatedDirectorMap(rail, viewport, view.framing.fovDeg);
    const director = new FlyoverVideoDirector({
      rail,
      framing: view.framing,
      aspect: viewport.width / viewport.height,
      fps: 30,
      speedIndex: FLYOVER_DEFAULT_SPEED_INDEX,
      map: sim.map,
    });
    let frames = 0;
    let orderOk = true;
    let segment = 0;
    let trailOk = true;
    let lastProgress = -1;
    let worstMove = 0;
    let worstBearing = 0;
    let worstPitch = 0;
    let worstAt = '';
    let previous: CameraPose | null = null;
    for (let shot = director.next(); shot; shot = director.next()) {
      frames += 1;
      const index = VIDEO_SEGMENT_ORDER.indexOf(shot.segment);
      if (index < segment) orderOk = false;
      segment = index;
      if ((shot.segment === 'intro' || shot.segment === 'outro') && shot.trailProgress !== 1) trailOk = false;
      if (shot.segment === 'play') {
        if (shot.trailProgress < lastProgress - 1e-9) trailOk = false;
        lastProgress = shot.trailProgress;
      }
      const pose = sim.applied(shot.camera);
      if (previous) {
        const mpu = metersPerMercatorUnitAtY(pose.y);
        const distance = Math.max(50, sim.distanceOf(pose));
        const move = Math.hypot((pose.x - previous.x) * mpu, (pose.y - previous.y) * mpu, pose.altitudeM - previous.altitudeM) / distance;
        const bearing = Math.abs(toDegrees(wrapPi(toRadians(pose.bearingDeg - previous.bearingDeg))));
        const pitch = Math.abs(pose.pitchDeg - previous.pitchDeg);
        if (move > worstMove) {
          worstMove = move;
          worstAt = `${shot.segment} #${shot.index}`;
        }
        worstBearing = Math.max(worstBearing, bearing);
        worstPitch = Math.max(worstPitch, pitch);
      }
      previous = pose;
    }
    check(fixtureId, `vidéo ${tag} : ${director.totalFrames} images annoncées, produites, plans dans l'ordre`, frames === director.totalFrames && orderOk, `${frames} images, ${round(director.durationS)} s`);
    check(fixtureId, `vidéo ${tag} : trace complète au début et à la fin, progression monotone`, trailOk && lastProgress >= 0.999, `fin ${round(lastProgress, 3)}`);
    check(
      fixtureId,
      `vidéo ${tag} : caméra continue (≤ 25 % de la distance visée, ≤ 2°/image)`,
      worstMove <= 0.25 && worstBearing <= 2 && worstPitch <= 2,
      `déplacement max ${round(worstMove * 100)} % (${worstAt}), cap ${round(worstBearing, 2)}°, inclinaison ${round(worstPitch, 2)}°`,
    );
  }
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function poseAt(frames: SimFrame[], t: number): SimFrame | null {
  let best: SimFrame | null = null;
  for (const frame of frames) {
    if (frame.t > t + 1e-9) break;
    best = frame;
  }
  return best;
}

export async function runFlyoverBenchmark(options: { quick?: boolean; only?: string[] } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Flyover 3D (rail caméra, transport, cadrage)');
  const rows: Array<Record<string, string | number>> = [];
  const fixtures = FIXTURES.map((make) => make()).filter((f) => !options.only || options.only.includes(f.id));

  for (const fixture of fixtures) {
    console.log(`\n■ ${fixture.label} (${fixture.points.length} points)`);
    const distances = cumulativeDistances(fixture.points);
    const track = buildRouteTrack(fixture.points, distances);
    if (!track) {
      check(fixture.id, 'trace exploitable', false, 'buildRouteTrack a renvoyé null');
      continue;
    }
    const t0 = performance.now();
    const rail = buildCameraRail(track);
    const buildMs = performance.now() - t0;
    const ground = profileGround(rail);

    const durationError = Math.abs(rail.durationS - rail.targetDurationS) / rail.targetDurationS;
    check(
      fixture.id,
      'durée du rail',
      durationError <= 0.02 || rail.durationS > rail.targetDurationS,
      `${round(rail.durationS)} s pour ${round(rail.targetDurationS)} s visés${rail.durationS > rail.targetDurationS * 1.02 ? ' (plafonds de rotation : plus long)' : ''}`,
    );

    const base = simulate(rail, ground, { fps: 60, speedIndex: FLYOVER_DEFAULT_SPEED_INDEX });
    const last = base.frames.at(-1);
    let monotonic = true;
    for (let i = 1; i < base.frames.length; i += 1) if (base.frames[i].s < base.frames[i - 1].s - 1e-9) monotonic = false;
    check(fixture.id, 'progression monotone, arrêt exact sur la fin', monotonic && Math.abs(base.endS - rail.lengthM) < 1e-6, `fin ${round(base.endS, 2)} / ${round(rail.lengthM, 2)} m`);
    const expected = rail.durationS + EASE_IN_START_S / 2 + ARRIVAL_BRAKING_S / 2;
    check(fixture.id, 'durée de lecture simulée', Math.abs((last?.t ?? 0) - expected) <= 0.05 * expected, `${round(last?.t ?? 0)} s (attendu ≈ ${round(expected)} s)`);

    const stats = headingStats(base.frames, 1 / 60);
    check(fixture.id, `rotation de cap ≤ ${HEADING_RATE_LIMIT.toFixed(1)}°/s`, stats.maxRate <= HEADING_RATE_LIMIT, `max ${round(stats.maxRate)}°/s, p99 ${round(stats.p99Rate)}°/s`);
    check(fixture.id, `accélération angulaire ≤ ${HEADING_ACCEL_LIMIT_DEG_S2}°/s²`, stats.maxAccel <= HEADING_ACCEL_LIMIT_DEG_S2, `max ${round(stats.maxAccel)}°/s², p99 ${round(stats.p99Accel)}°/s²`);

    const outside = base.frames.filter((f) => !(f.screenX >= SAFE_X[0] && f.screenX <= SAFE_X[1] && f.screenY >= SAFE_Y[0] && f.screenY <= SAFE_Y[1]));
    const ys = base.frames.map((f) => f.screenY).filter(Number.isFinite).sort((a, b) => a - b);
    const xs = base.frames.map((f) => f.screenX).filter(Number.isFinite).sort((a, b) => a - b);
    check(
      fixture.id,
      'tête toujours cadrée',
      outside.length === 0,
      `x ∈ [${round(xs[0] ?? NaN, 2)}, ${round(xs.at(-1) ?? NaN, 2)}], y ∈ [${round(ys[0] ?? NaN, 2)}, ${round(ys.at(-1) ?? NaN, 2)}]${outside.length ? `, ${outside.length} images hors cadre (1re à ${round(outside[0].t)} s)` : ''}`,
    );
    const landscapeZoom = zoomRate(base.frames, 60);
    check(fixture.id, `zoom sans à-coup (≤ ${ZOOM_RATE_LIMIT * 100} %/s)`, landscapeZoom <= ZOOM_RATE_LIMIT, `max ${round(landscapeZoom * 100, 1)} %/s`);
    const pitches = base.frames.map((f) => f.pitch);
    const minPitch = Math.min(...pitches);
    const maxPitch = Math.max(...pitches);
    check(fixture.id, `inclinaison dans [${PITCH_MIN_DEG - 5}°, ${PITCH_MAX_DEG}°]`, minPitch >= PITCH_MIN_DEG - 5 && maxPitch <= PITCH_MAX_DEG + 1e-6, `${round(minPitch)}°–${round(maxPitch)}°`);
    const clearances = base.frames.map((f) => f.clearance).filter((c): c is number => c != null);
    const minClearance = clearances.length ? Math.min(...clearances) : Number.NaN;
    check(fixture.id, 'œil au-dessus du relief connu', !(minClearance < 0), Number.isFinite(minClearance) ? `marge min ${round(minClearance)} m` : 'pas de relief');

    // Indépendance au framerate.
    const sims = [30, 144].map((fps) => simulate(rail, ground, { fps, speedIndex: FLYOVER_DEFAULT_SPEED_INDEX }));
    let worstPos = 0;
    let worstBearing = 0;
    for (let t = 0.5; t < (last?.t ?? 0) - 0.5; t += 0.5) {
      const ref = poseAt(base.frames, t);
      if (!ref) continue;
      for (const sim of sims) {
        const other = poseAt(sim.frames, t);
        if (!other) continue;
        // Les grilles de temps diffèrent d'au plus un pas : on compare à vitesse de rail près.
        const mpu = metersPerMercatorUnitAtY(ref.eyeY);
        const dPos = Math.hypot((ref.eyeX - other.eyeX) * mpu, (ref.eyeY - other.eyeY) * mpu, ref.eyeAlt - other.eyeAlt) / ref.distance;
        const dBearing = Math.abs(wrapPi(toRadians(ref.bearing - other.bearing))) * (180 / Math.PI);
        const step = Math.abs(ref.t - other.t);
        const tolerance = step > 1e-9 ? 1 + step * 60 : 1;
        worstPos = Math.max(worstPos, dPos / tolerance);
        worstBearing = Math.max(worstBearing, dBearing / tolerance);
      }
    }
    check(fixture.id, 'mêmes poses à 30/60/144 i/s', worstPos <= 0.01 && worstBearing <= 0.5, `écart max ${round(worstPos * 100, 2)} % de la distance, ${round(worstBearing, 2)}°`);

    // Vidéo 9:16 : rail du cadrage portrait, lecture à 30 i/s comme l'export.
    const portraitRail = buildCameraRail(track, undefined, PORTRAIT.framing.centerlineMaxOffsetPerDistance);
    const vertical = simulate(portraitRail, profileGround(portraitRail), { fps: 30, speedIndex: FLYOVER_DEFAULT_SPEED_INDEX, view: PORTRAIT });
    const verticalOutside = vertical.frames.filter(
      (f) => !(f.screenX >= PORTRAIT_SAFE_X[0] && f.screenX <= PORTRAIT_SAFE_X[1] && f.screenY >= PORTRAIT_SAFE_Y[0] && f.screenY <= PORTRAIT_SAFE_Y[1]),
    );
    const vys = vertical.frames.map((f) => f.screenY).filter(Number.isFinite).sort((a, b) => a - b);
    const vxs = vertical.frames.map((f) => f.screenX).filter(Number.isFinite).sort((a, b) => a - b);
    const medianY = vys[Math.floor(vys.length / 2)] ?? Number.NaN;
    check(
      fixture.id,
      '9:16 : tête toujours cadrée',
      verticalOutside.length === 0,
      `x ∈ [${round(vxs[0] ?? NaN, 2)}, ${round(vxs.at(-1) ?? NaN, 2)}], y ∈ [${round(vys[0] ?? NaN, 2)}, ${round(vys.at(-1) ?? NaN, 2)}]${verticalOutside.length ? `, ${verticalOutside.length} images hors cadre (1re à ${round(verticalOutside[0].t)} s)` : ''}`,
    );
    const portraitZoom = zoomRate(vertical.frames, 30);
    check(fixture.id, `9:16 : zoom sans à-coup (≤ ${ZOOM_RATE_LIMIT * 100} %/s)`, portraitZoom <= ZOOM_RATE_LIMIT, `max ${round(portraitZoom * 100, 1)} %/s`);
    check(fixture.id, '9:16 : tête sous le centre (médiane)', medianY >= PORTRAIT_MEDIAN_Y[0] && medianY <= PORTRAIT_MEDIAN_Y[1], `y médian ${round(medianY, 2)}`);
    const verticalStats = headingStats(vertical.frames, 1 / 30);
    const scale = framingScaleProfile({ rail: portraitRail, framing: PORTRAIT.framing, aspect: PORTRAIT.aspect, fps: 30, speedIndex: FLYOVER_DEFAULT_SPEED_INDEX, exaggeration: 1 });
    let scaleRate = 0;
    let reversals = 0;
    let lastDirection = 0;
    for (let i = 1; i < scale.length; i += 1) {
      const delta = scale[i] - scale[i - 1];
      scaleRate = Math.max(scaleRate, Math.abs(delta) * 30);
      const direction = delta > 1e-4 ? 1 : delta < -1e-4 ? -1 : 0;
      if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) reversals += 1;
      if (direction !== 0) lastDirection = direction;
    }
    const scaleMax = Math.max(...scale);
    // Un passage difficile = un recul puis un retour (2 inversions au plus par bosse, bosses ≥ 3 s).
    const reversalBudget = 2 * Math.max(1, Math.ceil(scale.length / 30 / 6));
    check(
      fixture.id,
      '9:16 : recul de cadrage sans pompage',
      scaleRate <= 0.35 && reversals <= reversalBudget,
      `recul max ×${round(scaleMax, 2)}, vitesse max ${round(scaleRate, 2)}/s, ${reversals} inversions`,
    );
    check(fixture.id, '9:16 : rotation de cap bornée', verticalStats.maxRate <= HEADING_RATE_LIMIT, `max ${round(verticalStats.maxRate)}°/s`);

    if (['alpe-dhuez', 'aller-retour', 'long', 'mini'].includes(fixture.id)) checkVideoMontage(fixture.id, track);

    // Changement de palier en cours de lecture : pas de saut de cap.
    const change = simulate(rail, ground, { fps: 60, speedIndex: FLYOVER_DEFAULT_SPEED_INDEX, speedChange: [Math.max(1, (last?.t ?? 2) * 0.4), FLYOVER_SPEED_STEPS.length - 1] });
    const changeStats = headingStats(change.frames, 1 / 60);
    check(fixture.id, 'passage 1× → 3× sans saut de cap', changeStats.maxRate <= HEADING_RATE_LIMIT * 1.6, `max ${round(changeStats.maxRate)}°/s`);

    const speeds = Array.from(rail.speedMps);
    rows.push({
      parcours: fixture.id,
      km: round(rail.lengthM / 1000, 1),
      'rail ms': round(buildMs, 1),
      'durée s': round(rail.durationS, 1),
      'v min→max km/s': `${round(Math.min(...speeds) / 1000, 2)}→${round(Math.max(...speeds) / 1000, 2)}`,
      'cap max °/s': round(stats.maxRate),
      'orbite max °': round(Math.max(...base.frames.map((f) => Math.abs(f.orbitDeg)))),
      'rotation totale °': round(base.frames.reduce((sum, frame, i) => (i ? sum + Math.abs(wrapPi(toRadians(frame.bearing - base.frames[i - 1].bearing))) : 0), 0) * (180 / Math.PI), 0),
      'µs/image': round(base.frameCostUs, 1),
    });
    suite.measureSync(
      { name: `Rail ${fixture.id} (${round(rail.lengthM / 1000, 1)} km)`, category: 'flyover', iterations: options.quick ? 2 : 4, warmupIterations: 1 },
      () => buildCameraRail(track),
    );
  }

  console.log('');
  console.table(rows);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} critères OK`);
  for (const f of failed) suite.addRegressionRisk(`[${f.fixture}] ${f.name} — ${f.detail}`);
  if (failed.length) process.exitCode = 1;
  return suite;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex > 0 ? process.argv[onlyIndex + 1]?.split(',') : undefined;
  await runFlyoverBenchmark({ only, quick: process.argv.includes('--quick') });
}
