import {
  ARRIVAL_HOLD_S,
  EASE_IN_START_S,
  FALLBACK_ELEVATION_HALF_LIFE_S,
  FLYOVER_SPEED_STEPS,
  GUARD_FALL_HALF_LIFE_S,
  GUARD_RISE_HALF_LIFE_S,
  HANDOFF_S,
  ORBIT_PERIOD_S,
  OVERVIEW_DURATION_MS,
  OVERVIEW_PITCH_DEG,
} from '../config';
import { approachDurationMs, zoomForCameraDistance } from '../engine/approach';
import {
  computeRailFrame,
  createCameraPose,
  createRailFrame,
  liftCameraPose,
  requiredLift,
  type CameraPose,
  type GroundSampler,
  type RailFrame,
} from '../engine/cameraPose';
import { RailClock, type CameraRail } from '../engine/cameraRail';
import { sampleAt } from '../engine/filters';
import type { FlyoverFraming } from '../engine/framing';
import { latFromMercatorY, toDegrees, toRadians, wrapPi } from '../engine/geo';
import { createTrackPosition, TrackCursor, type TrackPosition } from '../engine/routeTrack';
import { framingScaleProfile } from '../engine/screenGuard';
import { approachExponential, smootherstep, smoothstep } from '../engine/springs';
import { PlaybackTransport } from '../engine/transport';
import { INTRO_HOLD_S, INTRO_TRAIL_FADE_START, OUTRO_HOLD_S } from './config';
import { MapFlight, type MapView } from './flight';

/** Ce que le directeur lit de la carte qui rend la vidéo (synchrone, état de la dernière image). */
export interface DirectorMap {
  readonly viewport: { width: number; height: number };
  /** Relief rendu (exagéré) en un point Mercator. */
  readonly ground: GroundSampler;
  readonly exaggeration: number;
  /** Vue qui montre tout le parcours, au cap donné (`null` si impossible). */
  overviewView(bearingDeg: number): MapView | null;
  /** Vue de la caméra telle que la dernière image l'a posée. */
  currentView(): MapView;
  /** Pose de l'œil telle que la dernière image l'a posée (`null` en globe). */
  currentPose(out: CameraPose): CameraPose | null;
}

export type VideoCamera = { kind: 'view'; view: MapView } | { kind: 'pose'; pose: CameraPose };

export type VideoSegment = 'intro' | 'approach' | 'play' | 'arrival' | 'overview' | 'outro';

export interface VideoShot {
  readonly index: number;
  readonly segment: VideoSegment;
  readonly camera: VideoCamera;
  /** Tête de lecture (position sur la trace). */
  readonly head: TrackPosition;
  /** Partie de la trace dessinée (`line-progress`, 1 = tout le tracé). */
  readonly trailProgress: number;
  readonly trailOpacity: number;
}

interface HandoffOffset {
  x: number;
  y: number;
  altitudeM: number;
  pitchDeg: number;
  bearingDeg: number;
  elapsedS: number;
}

export interface FlyoverVideoDirectorOptions {
  rail: CameraRail;
  framing: FlyoverFraming;
  /** Largeur / hauteur de l'image. */
  aspect: number;
  fps: number;
  speedIndex: number;
  map: DirectorMap;
}

function framesFor(seconds: number, fps: number): number {
  return Math.max(1, Math.round(seconds * fps));
}

/**
 * Montage déterministe d'un flyover en vidéo, image par image à pas fixe
 * (1/fps) : plan d'ensemble sur tout le parcours, survol d'approche (chemin de
 * `flyTo`), raccord sur le rail, lecture (mêmes lois que `FlyoverController` :
 * transport, cap du palier, orbite hélico, garde-relief) avec en plus la
 * garde de cadrage de l'image étroite, tenue d'arrivée, retour à la vue
 * d'ensemble et plan final. Le nombre d'images est connu dès la construction.
 */
export class FlyoverVideoDirector {
  readonly totalFrames: number;
  readonly durationS: number;

  private readonly rail: CameraRail;
  private readonly framing: FlyoverFraming;
  private readonly dt: number;
  private readonly speedIndex: number;
  private readonly multiplier: number;
  private readonly map: DirectorMap;
  private readonly clock: RailClock;
  private readonly cursor: TrackCursor;
  private readonly transport: PlaybackTransport;
  /** Recul de cadrage par image de lecture (pré-calculé, `framingScaleProfile`). */
  private readonly framingScale: Float64Array;
  private readonly frame: RailFrame = createRailFrame();
  private readonly head = createTrackPosition();
  private readonly scratchPose = createCameraPose();
  private readonly scratchView: MapView = { x: 0, y: 0, zoom: 0, pitchDeg: 0, bearingDeg: 0 };

  private readonly introFrames: number;
  private readonly approachFrames: number;
  private readonly playFrames: number;
  private readonly arrivalFrames: number;
  private readonly overviewFrames: number;
  private readonly outroFrames: number;
  private readonly introView: MapView;
  private readonly approach: MapFlight;

  private index = 0;
  /** Image de lecture en cours (-1 avant la première). */
  private playIndex = -1;
  private liftM = 0;
  private fallbackAltitudeM: number | null = null;
  private orbitTimeS = 0;
  private handoff: HandoffOffset | null = null;
  private outroFlight: MapFlight | null = null;
  private outroView: MapView | null = null;
  private distanceM = 0;

  constructor(options: FlyoverVideoDirectorOptions) {
    const { rail, framing, fps, map } = options;
    this.rail = rail;
    this.framing = framing;
    this.dt = 1 / fps;
    this.speedIndex = Math.max(0, Math.min(FLYOVER_SPEED_STEPS.length - 1, options.speedIndex));
    this.multiplier = FLYOVER_SPEED_STEPS[this.speedIndex];
    this.map = map;
    this.clock = new RailClock(rail);
    this.cursor = new TrackCursor(rail.track);
    this.transport = new PlaybackTransport(rail.durationS, this.multiplier);
    // Même simulation de la lecture que `next()` : une valeur par image de lecture.
    this.framingScale = framingScaleProfile({
      rail,
      framing,
      aspect: options.aspect,
      fps,
      speedIndex: this.speedIndex,
      exaggeration: map.exaggeration,
    });

    // Vue d'arrivée de l'approche : l'équivalent haut niveau de la pose du rail au départ.
    const start = this.railFrame(0, 0);
    liftCameraPose(start, this.liftM);
    const targetLat = latFromMercatorY(start.targetY);
    const startView: MapView = {
      x: start.targetX,
      y: start.targetY,
      zoom: zoomForCameraDistance(
        Math.hypot(start.horizontalM, start.verticalM),
        targetLat,
        map.viewport.height,
        framing.fovDeg,
      ),
      pitchDeg: start.pose.pitchDeg,
      bearingDeg: start.pose.bearingDeg,
    };
    this.introView = map.overviewView(start.pose.bearingDeg) ?? startView;
    const approachS = approachDurationMs(this.introView, startView, map.viewport) / 1000;
    this.approach = new MapFlight(this.introView, startView, map.viewport);

    this.introFrames = framesFor(INTRO_HOLD_S, fps);
    this.approachFrames = framesFor(approachS, fps);
    this.playFrames = this.framingScale.length;
    this.arrivalFrames = framesFor(ARRIVAL_HOLD_S, fps);
    this.overviewFrames = framesFor(OVERVIEW_DURATION_MS / 1000, fps);
    this.outroFrames = framesFor(OUTRO_HOLD_S, fps);
    this.totalFrames =
      this.introFrames + this.approachFrames + this.playFrames + this.arrivalFrames + this.overviewFrames + this.outroFrames;
    this.durationS = this.totalFrames * this.dt;
    this.cursor.locate(0, this.head);
  }

  /** Vue d'ouverture (à poser avant la première image : la carte y charge ses tuiles). */
  get firstView(): MapView {
    return this.introView;
  }

  /** Image suivante, `null` à la fin. À appeler une fois l'image précédente rendue. */
  next(): VideoShot | null {
    const index = this.index;
    if (index >= this.totalFrames) return null;
    this.index += 1;
    let local = index;
    if (local < this.introFrames) return this.viewShot(index, 'intro', this.introView, 0, 1, 1);
    local -= this.introFrames;
    if (local < this.approachFrames) {
      const t = (local + 1) / this.approachFrames;
      const view = this.approach.viewAt(t, this.scratchView);
      const fade = 1 - smoothstep((t - INTRO_TRAIL_FADE_START) / (1 - INTRO_TRAIL_FADE_START));
      return this.viewShot(index, 'approach', view, 0, 1, fade);
    }
    local -= this.approachFrames;
    if (local < this.playFrames + this.arrivalFrames) {
      if (local === 0) this.beginPlay();
      const playing = local < this.playFrames;
      if (playing) this.stepTransport();
      const pose = this.applyRailFrame();
      return {
        index,
        segment: playing ? 'play' : 'arrival',
        camera: { kind: 'pose', pose },
        head: this.head,
        trailProgress: this.distanceM >= this.rail.lengthM ? 1 : this.head.lineProgress,
        trailOpacity: 1,
      };
    }
    local -= this.playFrames + this.arrivalFrames;
    if (local < this.overviewFrames) {
      if (local === 0) this.beginOutro();
      const flight = this.outroFlight;
      const view = flight ? flight.viewAt((local + 1) / this.overviewFrames, this.scratchView) : this.map.currentView();
      return this.viewShot(index, 'overview', view, this.rail.lengthM, 1, 1);
    }
    return this.viewShot(index, 'outro', this.outroView ?? this.map.currentView(), this.rail.lengthM, 1, 1);
  }

  /* ── Lecture ───────────────────────────────────────────────────────── */

  /** Raccord : l'écart entre la pose réelle (fin du survol) et le rail s'efface en HANDOFF_S. */
  private beginPlay(): void {
    this.transport.seek(0);
    this.transport.start(EASE_IN_START_S);
    const frame = this.railFrame(0, 0);
    liftCameraPose(frame, this.liftM);
    const current = this.map.currentPose(this.scratchPose);
    this.handoff = current
      ? {
          x: current.x - frame.pose.x,
          y: current.y - frame.pose.y,
          altitudeM: current.altitudeM - frame.pose.altitudeM,
          pitchDeg: current.pitchDeg - frame.pose.pitchDeg,
          bearingDeg: toDegrees(wrapPi(toRadians(current.bearingDeg - frame.pose.bearingDeg))),
          elapsedS: 0,
        }
      : null;
  }

  private stepTransport(): void {
    const transport = this.transport;
    transport.step(this.dt);
    this.playIndex += 1;
    const motion = transport.rate / Math.max(1e-6, transport.multiplierValue);
    this.orbitTimeS += this.dt * Math.max(0, Math.min(1, motion));
    this.distanceM = this.clock.distanceAt(transport.playbackTime);
  }

  private railFrame(distanceM: number, dt: number): RailFrame {
    const rail = this.rail;
    let fallbackAltitudeM = 0;
    if (!rail.hasElevation) {
      const index = Math.min(rail.count - 1, distanceM / rail.spacingM);
      const ground = this.map.ground(sampleAt(rail.centerX, index), sampleAt(rail.centerY, index));
      if (ground != null) {
        this.fallbackAltitudeM =
          this.fallbackAltitudeM == null
            ? ground
            : approachExponential(this.fallbackAltitudeM, ground, FALLBACK_ELEVATION_HALF_LIFE_S, dt);
      }
      fallbackAltitudeM = this.fallbackAltitudeM ?? 0;
    }
    return computeRailFrame(
      rail,
      {
        distanceM,
        speedMultiplier: this.transport.multiplierValue,
        headingRad: sampleAt(rail.heading(this.speedIndex), distanceM / rail.spacingM),
        orbitPhaseRad: (2 * Math.PI * this.orbitTimeS) / ORBIT_PERIOD_S,
        fovDistanceFactor: this.framing.distanceFactor * this.framingScaleAt(),
        targetLeadPerDistance: this.framing.targetLeadPerDistance,
        exaggeration: this.map.exaggeration,
        fallbackTargetAltitudeM: fallbackAltitudeM,
      },
      this.frame,
    );
  }

  /** Recul de cadrage de l'image de lecture en cours (l'arrivée garde le dernier). */
  private framingScaleAt(): number {
    const scale = this.framingScale;
    return scale[Math.max(0, Math.min(scale.length - 1, this.playIndex))] ?? 1;
  }

  /** Pose de l'image : rail (recul de cadrage compris), garde-relief, raccord. */
  private applyRailFrame(): CameraPose {
    const rail = this.rail;
    const dt = this.dt;
    const distanceM = this.distanceM;
    const head = this.cursor.locate(distanceM, this.head);
    const frame = this.railFrame(distanceM, dt);

    const exaggeration = this.map.exaggeration;
    const headAltitudeM = rail.hasElevation ? head.elevationM * exaggeration : frame.targetAltitudeM;
    const behindIndex = Math.max(0, distanceM - frame.horizontalM) / rail.spacingM;
    const eyeGroundFallbackM = rail.hasElevation
      ? Math.max(sampleAt(rail.elevationM, behindIndex), head.elevationM) * exaggeration
      : frame.targetAltitudeM;
    const needed = requiredLift(frame, head.x, head.y, headAltitudeM, this.map.ground, eyeGroundFallbackM);
    this.liftM = approachExponential(
      this.liftM,
      needed,
      needed > this.liftM ? GUARD_RISE_HALF_LIFE_S : GUARD_FALL_HALF_LIFE_S,
      dt,
    );
    liftCameraPose(frame, this.liftM);

    const pose = frame.pose;
    const handoff = this.handoff;
    if (handoff) {
      handoff.elapsedS += dt;
      const weight = 1 - smootherstep(handoff.elapsedS / HANDOFF_S);
      pose.x += handoff.x * weight;
      pose.y += handoff.y * weight;
      pose.altitudeM += handoff.altitudeM * weight;
      pose.pitchDeg += handoff.pitchDeg * weight;
      pose.bearingDeg += handoff.bearingDeg * weight;
      if (handoff.elapsedS >= HANDOFF_S) this.handoff = null;
    }
    return pose;
  }

  /* ── Vue d'ensemble finale ─────────────────────────────────────────── */

  private beginOutro(): void {
    const from = this.map.currentView();
    const to = this.map.overviewView(from.bearingDeg);
    if (!to) {
      this.outroView = { ...from };
      return;
    }
    this.outroView = { ...to, pitchDeg: OVERVIEW_PITCH_DEG };
    this.outroFlight = new MapFlight(from, this.outroView, this.map.viewport);
  }

  private viewShot(
    index: number,
    segment: VideoSegment,
    view: MapView,
    headDistanceM: number,
    trailProgress: number,
    trailOpacity: number,
  ): VideoShot {
    this.cursor.locate(headDistanceM, this.head);
    return { index, segment, camera: { kind: 'view', view }, head: this.head, trailProgress, trailOpacity };
  }
}
