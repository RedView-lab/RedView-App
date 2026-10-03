import type { Map as MapboxMap, Marker } from 'mapbox-gl';
import { requestFreeCamExit, subscribeFreeCam } from '@/features/freeCam';
import { setCameraOwner, suspendMapInteractions } from '@/features/map3d';
import {
  clearAnalysisFlyoverProgress,
  getRouteElevationContext,
  isAnalysisFlyoverRouteMounted,
  setAnalysisFlyoverProgress,
  setAnalysisFlyoverRoute,
  setRouteLayerVisibility,
} from '@/features/itineraryPanel/lib/route-layer';
import { setPoiLayersSuppressed } from '@/features/poi/lib/poi-markers';
import { createRouteDotMarker, setRouteDotMarkerColor } from '../components/analysis/routeDotMarker';
import {
  APPROACH_CURVE,
  ARRIVAL_HOLD_S,
  CURSOR_EMIT_INTERVAL_MS,
  EASE_IN_RESUME_S,
  EASE_IN_START_S,
  FALLBACK_ELEVATION_HALF_LIFE_S,
  FLYOVER_DEFAULT_SPEED_INDEX,
  FLYOVER_FOV_DEG,
  FLYOVER_SPEED_STEPS,
  FOV_RESTORE_MS,
  GUARD_FALL_HALF_LIFE_S,
  GUARD_RISE_HALF_LIFE_S,
  HANDOFF_ANGLE_TOLERANCE_DEG,
  HANDOFF_POSITION_TOLERANCE,
  HANDOFF_S,
  LAYER_CONTEXT_CHECK_INTERVAL_MS,
  MAPBOX_DEFAULT_FOV_DEG,
  MAX_FRAME_DT_S,
  ORBIT_PERIOD_S,
  OVERVIEW_DURATION_MS,
  OVERVIEW_PADDING_RATIO,
  OVERVIEW_PITCH_DEG,
  PAUSE_DECELERATION_S,
  STATUS_EMIT_INTERVAL_MS,
} from './config';
import { approachDurationMs, zoomForCameraDistance } from './engine/approach';
import {
  computeRailFrame,
  createCameraPose,
  createRailFrame,
  liftCameraPose,
  requiredLift,
  type CameraPose,
  type GroundSampler,
} from './engine/cameraPose';
import { buildCameraRail, RailClock, type CameraRail } from './engine/cameraRail';
import { sampleAt } from './engine/filters';
import {
  latFromMercatorY,
  lngFromMercatorX,
  mercatorXFromLng,
  mercatorYFromLat,
  metersPerMercatorUnitAtY,
  toRadians,
  wrapPi,
} from './engine/geo';
import { fovDistanceFactor, headingBlendDurationS, playbackDurationForLength } from './engine/laws';
import { buildRouteTrack, createTrackPosition, TrackCursor } from './engine/routeTrack';
import { approachExponential, smootherstep } from './engine/springs';
import { PlaybackTransport } from './engine/transport';
import {
  applyCameraPose,
  batchCameraEvents,
  FLYOVER_EVENT_DATA,
  readCameraPose,
  type CameraEventBatch,
} from './map/cameraDriver';
import { FovController } from './map/fov';
import { createGroundSampler, readTerrainExaggeration } from './map/terrain';
import type { FlyoverInput, FlyoverPhase, FlyoverRouteInput, FlyoverStatus } from './types';

type Listener = () => void;

interface Session {
  readonly route: FlyoverRouteInput;
  readonly rail: CameraRail;
  readonly clock: RailClock;
  readonly cursor: TrackCursor;
  readonly transport: PlaybackTransport;
  marker: Marker | null;
  color: string;
  distanceM: number;
  layerSignature: string;
  contextTimer: number;
}

interface PoseOffset {
  x: number;
  y: number;
  altitudeM: number;
  pitchDeg: number;
  bearingDeg: number;
  elapsedS: number;
}

const RUNNING_PHASES: ReadonlySet<FlyoverPhase> = new Set(['approaching', 'handoff', 'playing']);
const SPEED_STEP_COUNT = FLYOVER_SPEED_STEPS.length;

function sameRoute(a: FlyoverRouteInput | null, b: FlyoverRouteInput | null): boolean {
  return a === b || (a != null && b != null && a.itineraryId === b.itineraryId && a.points === b.points && a.distancesM === b.distancesM);
}

function isMapAlive(map: MapboxMap): boolean {
  return Boolean((map as unknown as { style?: unknown }).style);
}

/**
 * Lecture 3D de l'itinéraire, hors React : rail caméra pré-calculé, horloge,
 * boucle rAF O(1) par image, pilotage FreeCamera, traînée et tête sur la
 * carte, et deux canaux d'état pour l'UI (statut ≤ 4 Hz, curseur du
 * graphique ≤ 30 Hz) lus par `useSyncExternalStore`.
 */
export class FlyoverController {
  private input: FlyoverInput = { route: null, toChartX: null };
  private railCache: { route: FlyoverRouteInput; rail: CameraRail | null } | null = null;
  private session: Session | null = null;
  private phase: FlyoverPhase = 'idle';
  private speedIndex = FLYOVER_DEFAULT_SPEED_INDEX;

  // Caméra
  private readonly frame = createRailFrame();
  private readonly head = createTrackPosition();
  private readonly scratchPose = createCameraPose();
  private headingTrack = FLYOVER_DEFAULT_SPEED_INDEX;
  private headingOffset = 0;
  private headingBlendS = Number.POSITIVE_INFINITY;
  private headingBlendDurationS = 0;
  private liftM = 0;
  private fallbackAltitudeM: number | null = null;
  private handoff: PoseOffset | null = null;
  private arrivalHoldS = 0;
  private exaggeration = 0;
  private ground: GroundSampler = () => null;
  /** Temps d'orbite hélico : avance avec la lecture, s'arrête avec elle. */
  private orbitTimeS = 0;

  // Boucle et appropriation de la carte
  private frameId = 0;
  private lastFrameTime = 0;
  private eventBatch: CameraEventBatch | null = null;
  private restoreInteractions: (() => void) | null = null;
  private transitionToken = 0;
  /** L'approche en cours débouche sur la lecture (sinon : seek en pause, on reste en pause). */
  private approachResumes = false;
  private transitionEnd: ((event: unknown) => void) | null = null;
  private prebuildHandle: number | null = null;

  // Diffusion
  private status: FlyoverStatus;
  private readonly statusListeners = new Set<Listener>();
  private cursorX: number | null = null;
  private readonly cursorListeners = new Set<Listener>();
  private lastStatusEmit = 0;
  private lastCursorEmit = 0;

  private unsubscribeFreeCam: (() => void) | null = null;
  private connected = false;

  private readonly map: MapboxMap;
  private readonly fov: FovController;

  /** Sans effet de bord : la carte n'est touchée qu'après `connect()`. */
  constructor(map: MapboxMap) {
    this.map = map;
    this.fov = new FovController(map);
    this.status = this.buildStatus();
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.unsubscribeFreeCam = subscribeFreeCam((active) => {
      if (!active) return;
      this.pauseNow();
      // La FreeCam raisonne avec le champ Mapbox par défaut ; l'approche le reprendra.
      this.fov.restore(0);
    });
    this.map.on('style.load', this.handleStyleLoad);
    this.schedulePrebuild();
  }

  /** Ferme la lecture (tracé normal réaffiché, carte rendue) et se désabonne ; `connect()` peut suivre. */
  disconnect(): void {
    if (!this.connected) return;
    this.closeSession();
    this.cancelPrebuild();
    this.unsubscribeFreeCam?.();
    this.unsubscribeFreeCam = null;
    this.map.off('style.load', this.handleStyleLoad);
    this.connected = false;
  }

  /* ── Canaux pour React ─────────────────────────────────────────────── */

  readonly subscribeStatus = (listener: Listener): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  readonly getStatus = (): FlyoverStatus => this.status;

  readonly subscribeCursor = (listener: Listener): (() => void) => {
    this.cursorListeners.add(listener);
    return () => this.cursorListeners.delete(listener);
  };

  readonly getCursorX = (): number | null => this.cursorX;

  /* ── Entrées ───────────────────────────────────────────────────────── */

  setInput(input: FlyoverInput): void {
    const previous = this.input;
    this.input = input;
    if (!sameRoute(previous.route, input.route)) {
      // Trace modifiée ou autre itinéraire : la lecture en cours n'a plus de sens.
      this.closeSession();
      this.railCache = null;
      this.schedulePrebuild();
    } else if (this.session && input.route && input.route.color !== this.session.color) {
      this.recolor(input.route.color);
    }
    if (previous.toChartX !== input.toChartX) this.emitCursor(true);
    this.emitStatus(true);
  }

  /* ── Commandes ─────────────────────────────────────────────────────── */

  togglePlayback(): void {
    switch (this.phase) {
      case 'idle':
      case 'ended':
      case 'arriving':
      case 'overview':
        this.playFrom(0);
        return;
      case 'paused':
        this.beginApproach(true);
        return;
      case 'pausing':
        this.setPhase('playing');
        this.session?.transport.start(EASE_IN_RESUME_S);
        return;
      case 'approaching':
        if (this.approachResumes) this.pauseNow();
        else {
          this.approachResumes = true;
          this.emitStatus(true);
        }
        return;
      case 'handoff':
      case 'playing':
        this.session?.transport.stop(PAUSE_DECELERATION_S);
        this.setPhase('pausing');
        return;
    }
  }

  slowDown(): void {
    this.setSpeedIndex(this.speedIndex - 1);
  }

  speedUp(): void {
    this.setSpeedIndex(this.speedIndex + 1);
  }

  /** « Revenir au début » : quitte la lecture, tracé normal réaffiché. */
  reset(): void {
    this.closeSession();
    this.emitStatus(true);
  }

  /** Seek pendant une session ouverte. Rend `false` s'il n'y en a pas. */
  seekToDistance(distanceM: number): boolean {
    const session = this.session;
    if (!session || !Number.isFinite(distanceM)) return false;
    const target = Math.max(0, Math.min(session.rail.lengthM, distanceM));
    const resume = this.isRunning();
    this.cancelTransition();
    this.stopLoop();
    this.releaseEventBatch();
    session.transport.halt();
    session.transport.seek(session.clock.timeAt(target));
    this.headingOffset = 0;
    this.headingBlendS = Number.POSITIVE_INFINITY;
    this.handoff = null;
    this.updateHead(session, target);
    this.emitCursor(true);
    this.beginApproach(resume);
    return true;
  }

  /* ── Rail ──────────────────────────────────────────────────────────── */

  private ensureRail(): CameraRail | null {
    const route = this.input.route;
    if (!route) return null;
    if (this.railCache && sameRoute(this.railCache.route, route)) return this.railCache.rail;
    const track = buildRouteTrack(route.points, route.distancesM);
    const rail = track ? buildCameraRail(track) : null;
    this.railCache = { route, rail };
    return rail;
  }

  /** Construit le rail pendant un temps mort : Play démarre sans attente et la durée affichée est exacte. */
  private schedulePrebuild(): void {
    this.cancelPrebuild();
    if (!this.connected || !this.input.route) return;
    const run = () => {
      this.prebuildHandle = null;
      if (!this.connected) return;
      this.ensureRail();
      this.emitStatus(true);
    };
    this.prebuildHandle =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(run, { timeout: 2000 })
        : window.setTimeout(run, 300);
  }

  private cancelPrebuild(): void {
    if (this.prebuildHandle == null) return;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(this.prebuildHandle);
    window.clearTimeout(this.prebuildHandle);
    this.prebuildHandle = null;
  }

  /* ── Session ───────────────────────────────────────────────────────── */

  private playFrom(distanceM: number): void {
    const route = this.input.route;
    const rail = this.ensureRail();
    if (!route || !rail) return;
    if (this.session && !sameRoute(this.session.route, route)) this.closeSession();
    const session = this.session ?? this.openSession(route, rail);
    this.cancelTransition();
    this.stopLoop();
    this.releaseEventBatch();
    session.transport.halt();
    session.transport.seek(session.clock.timeAt(distanceM));
    this.updateHead(session, distanceM);
    this.beginApproach(true);
  }

  private openSession(route: FlyoverRouteInput, rail: CameraRail): Session {
    const multiplier = FLYOVER_SPEED_STEPS[this.speedIndex];
    const session: Session = {
      route,
      rail,
      clock: new RailClock(rail),
      cursor: new TrackCursor(rail.track),
      transport: new PlaybackTransport(rail.durationS, multiplier),
      marker: null,
      color: route.color,
      distanceM: 0,
      layerSignature: '',
      contextTimer: 0,
    };
    this.session = session;
    this.headingTrack = this.speedIndex;
    this.headingOffset = 0;
    this.headingBlendS = Number.POSITIVE_INFINITY;
    this.liftM = 0;
    this.fallbackAltitudeM = null;
    this.handoff = null;
    this.orbitTimeS = 0;
    this.mountLayers(session);
    this.refreshTerrain();
    session.contextTimer = window.setInterval(() => this.checkLayerContext(), LAYER_CONTEXT_CHECK_INTERVAL_MS);
    return session;
  }

  private closeSession(): void {
    const session = this.session;
    this.cancelTransition();
    this.stopLoop();
    this.releaseCamera();
    if (session) {
      window.clearInterval(session.contextTimer);
      session.marker?.remove();
      if (isMapAlive(this.map)) {
        clearAnalysisFlyoverProgress(this.map);
        setRouteLayerVisibility(this.map, session.route.itineraryId, true);
        setPoiLayersSuppressed(this.map, false);
        delete this.map.getContainer().dataset.rvFlyoverSession;
        this.fov.restore(FOV_RESTORE_MS);
      }
      this.session = null;
    }
    this.handoff = null;
    this.setPhase('idle');
    this.emitCursor(true);
  }

  /** Lecture en cours ou en train d'y aller (icône Pause). */
  private isRunning(): boolean {
    return this.phase === 'handoff' || this.phase === 'playing' || (this.phase === 'approaching' && this.approachResumes);
  }

  /**
   * La lecture ne montre que la trace : trace complète du flyover posée,
   * tracé normal masqué, POI masqués, marqueurs et popups de la carte cachés
   * (`[data-rv-flyover-session]`, src/index.css) sauf la tête. Rejoué après
   * un changement de style.
   */
  private mountLayers(session: Session): void {
    if (!isMapAlive(this.map)) return;
    const mounted = setAnalysisFlyoverRoute(this.map, session.route.points, session.color);
    session.layerSignature = mounted ? getRouteElevationContext(this.map).signature : '';
    this.hideNonTraceOverlays(session);
    this.updateHead(session, session.distanceM);
  }

  private hideNonTraceOverlays(session: Session): void {
    setRouteLayerVisibility(this.map, session.route.itineraryId, false);
    setPoiLayersSuppressed(this.map, true);
    this.map.getContainer().dataset.rvFlyoverSession = '';
  }

  private recolor(color: string): void {
    const session = this.session;
    if (!session) return;
    session.color = color;
    if (session.marker) setRouteDotMarkerColor(session.marker, color);
    this.mountLayers(session);
  }

  /** Vérification lente : style rechargé, qualité DEM / exagération changées, tracé ré-affiché par sa couche. */
  private checkLayerContext(): void {
    const session = this.session;
    if (!session || !isMapAlive(this.map)) return;
    this.refreshTerrain();
    const signature = getRouteElevationContext(this.map).signature;
    if (signature !== session.layerSignature || !isAnalysisFlyoverRouteMounted(this.map)) {
      this.mountLayers(session);
    } else {
      // Un hook peut avoir remonté une couche entre-temps (prédiction, POI recréés).
      this.hideNonTraceOverlays(session);
    }
  }

  private readonly handleStyleLoad = () => {
    const session = this.session;
    if (!session) return;
    // Les couches de l'itinéraire sont reposées par leur propre hook juste après.
    window.setTimeout(() => {
      if (this.session === session) this.mountLayers(session);
    }, 0);
  };

  private refreshTerrain(): void {
    this.exaggeration = readTerrainExaggeration(this.map);
    this.ground = createGroundSampler(this.map, this.exaggeration > 0);
  }

  private updateHead(session: Session, distanceM: number): void {
    session.distanceM = distanceM;
    const head = session.cursor.locate(distanceM, this.head);
    if (!isMapAlive(this.map)) return;
    setAnalysisFlyoverProgress(this.map, distanceM >= session.rail.lengthM ? 1 : head.lineProgress);
    if (session.marker) {
      session.marker.setLngLat([head.lng, head.lat]);
    } else {
      session.marker = createRouteDotMarker(this.map, [head.lng, head.lat], session.color);
      // Seul marqueur laissé visible pendant la lecture.
      session.marker.getElement().dataset.rvFlyoverHead = '';
    }
  }

  /* ── Appropriation de la caméra ────────────────────────────────────── */

  private takeCamera(): void {
    requestFreeCamExit();
    if (!this.restoreInteractions) this.restoreInteractions = suspendMapInteractions(this.map);
    setCameraOwner('flyover');
  }

  private releaseCamera(): void {
    this.releaseEventBatch();
    if (this.restoreInteractions) {
      try {
        this.restoreInteractions();
      } catch {
        /* carte détruite */
      }
      this.restoreInteractions = null;
    }
    setCameraOwner(null);
  }

  private releaseEventBatch(): void {
    this.eventBatch?.release();
    this.eventBatch = null;
  }

  /* ── Transitions Mapbox (approche, vue d'ensemble) ─────────────────── */

  /**
   * Survol (`flyTo`, chemin de van Wijk) jusqu'à l'équivalent haut niveau de
   * la pose du rail, puis raccord FreeCamera. `flyTo` marche aussi depuis le
   * globe, où la FreeCamera est ignorée. Sautée si la caméra y est déjà.
   */
  private beginApproach(resume: boolean): void {
    const session = this.session;
    if (!session) return;
    this.cancelTransition();
    this.stopLoop();
    this.releaseEventBatch();
    this.approachResumes = resume;
    this.setPhase('approaching');
    this.takeCamera();

    const frame = this.computeFrame(session, session.distanceM, 0);
    liftCameraPose(frame, this.liftM);
    const current = readCameraPose(this.map, this.scratchPose);
    if (current && this.poseIsClose(current, frame.pose, frame.distanceM)) {
      this.fov.animateTo(FLYOVER_FOV_DEG, HANDOFF_S * 1000);
      this.afterApproach();
      return;
    }

    const container = this.map.getContainer();
    const viewport = { width: container.clientWidth || 1, height: container.clientHeight || 1 };
    const targetLat = latFromMercatorY(frame.targetY);
    const eyeToTargetM = Math.hypot(frame.horizontalM, frame.verticalM + this.liftM);
    const zoom = zoomForCameraDistance(eyeToTargetM, targetLat, viewport.height, this.viewFovDeg());
    const center = this.map.getCenter();
    const duration = approachDurationMs(
      { x: mercatorXFromLng(center.lng), y: mercatorYFromLat(center.lat), zoom: this.map.getZoom() },
      { x: frame.targetX, y: frame.targetY, zoom },
      viewport,
    );
    // Le champ s'ouvre pendant le survol : aucun saut de cadrage.
    this.fov.animateTo(FLYOVER_FOV_DEG, duration);
    this.runTransition(
      {
        center: [lngFromMercatorX(frame.targetX), targetLat],
        zoom,
        pitch: frame.pose.pitchDeg,
        bearing: frame.pose.bearingDeg,
        duration,
      },
      () => this.afterApproach(),
    );
  }

  private afterApproach(): void {
    if (this.phase !== 'approaching') return;
    if (this.approachResumes) {
      this.beginHandoff();
      return;
    }
    this.enterPaused();
  }

  private enterPaused(): void {
    this.handoff = null;
    this.setPhase('paused');
    this.releaseCamera();
  }

  /** Lance un `flyTo` marqué ; `onEnd` à son `moveend` (fin ou interruption), sauf s'il a été annulé. */
  private runTransition(
    options: { center: [number, number]; zoom: number; pitch: number; bearing: number; duration: number },
    onEnd: () => void,
  ): void {
    const token = ++this.transitionToken;
    const handler = (event: unknown) => {
      if ((event as { flyover?: boolean }).flyover !== true || token !== this.transitionToken) return;
      this.detachTransitionEnd();
      onEnd();
    };
    this.transitionEnd = handler;
    this.map.on('moveend', handler);
    this.map.flyTo({ ...options, curve: APPROACH_CURVE, essential: true }, FLYOVER_EVENT_DATA);
  }

  private cancelTransition(): void {
    this.transitionToken += 1;
    if (this.transitionEnd) {
      this.detachTransitionEnd();
      try {
        this.map.stop();
      } catch {
        /* carte détruite */
      }
    }
  }

  private detachTransitionEnd(): void {
    if (!this.transitionEnd) return;
    this.map.off('moveend', this.transitionEnd);
    this.transitionEnd = null;
  }

  private poseIsClose(a: CameraPose, b: CameraPose, distanceM: number): boolean {
    const metersPerUnit = metersPerMercatorUnitAtY(b.y);
    const offsetM = Math.hypot((a.x - b.x) * metersPerUnit, (a.y - b.y) * metersPerUnit, a.altitudeM - b.altitudeM);
    return (
      offsetM <= HANDOFF_POSITION_TOLERANCE * distanceM &&
      Math.abs(a.pitchDeg - b.pitchDeg) <= HANDOFF_ANGLE_TOLERANCE_DEG &&
      Math.abs(wrapPi(toRadians(a.bearingDeg - b.bearingDeg))) <= toRadians(HANDOFF_ANGLE_TOLERANCE_DEG)
    );
  }

  /**
   * Raccord : l'écart entre la pose réelle (fin du survol, centre Mapbox calé
   * sur le relief) et le rail s'efface en HANDOFF_S pendant que la lecture
   * démarre en douceur.
   */
  private beginHandoff(): void {
    const session = this.session;
    if (!session) return;
    this.setPhase('handoff');
    this.eventBatch = batchCameraEvents(this.map);
    const frame = this.computeFrame(session, session.distanceM, 0);
    liftCameraPose(frame, this.liftM);
    const current = readCameraPose(this.map, this.scratchPose);
    this.handoff = current
      ? {
          x: current.x - frame.pose.x,
          y: current.y - frame.pose.y,
          altitudeM: current.altitudeM - frame.pose.altitudeM,
          pitchDeg: current.pitchDeg - frame.pose.pitchDeg,
          bearingDeg: wrapPi(toRadians(current.bearingDeg - frame.pose.bearingDeg)) * (180 / Math.PI),
          elapsedS: 0,
        }
      : null;
    session.transport.start(session.distanceM <= 1 ? EASE_IN_START_S : EASE_IN_RESUME_S);
    this.startLoop();
  }

  private beginOverview(): void {
    const session = this.session;
    if (!session) return;
    this.stopLoop();
    this.releaseEventBatch();
    this.setPhase('overview');
    const container = this.map.getContainer();
    const padding = Math.round(OVERVIEW_PADDING_RATIO * Math.min(container.clientWidth, container.clientHeight));
    let camera: ReturnType<MapboxMap['cameraForBounds']>;
    try {
      camera = this.map.cameraForBounds(session.rail.track.bounds as [[number, number], [number, number]], {
        padding,
        bearing: this.map.getBearing(),
        pitch: OVERVIEW_PITCH_DEG,
      });
    } catch {
      camera = undefined;
    }
    const center = camera?.center;
    if (!camera || center == null || !Number.isFinite(camera.zoom)) {
      this.enterEnded();
      return;
    }
    const lngLat = Array.isArray(center)
      ? (center as [number, number])
      : ([(center as { lng: number }).lng, (center as { lat: number }).lat] as [number, number]);
    this.runTransition(
      {
        center: lngLat,
        zoom: camera.zoom as number,
        pitch: OVERVIEW_PITCH_DEG,
        bearing: this.map.getBearing(),
        duration: OVERVIEW_DURATION_MS,
      },
      () => this.enterEnded(),
    );
  }

  private enterEnded(): void {
    if (this.phase !== 'overview' && this.phase !== 'arriving') return;
    this.setPhase('ended');
    this.releaseCamera();
  }

  /** Arrêt immédiat (FreeCam qui prend la main, pause pendant le survol d'approche). */
  private pauseNow(): void {
    if (!RUNNING_PHASES.has(this.phase) && this.phase !== 'pausing') return;
    this.cancelTransition();
    this.stopLoop();
    this.session?.transport.halt();
    this.enterPaused();
  }

  /* ── Vitesse ───────────────────────────────────────────────────────── */

  private setSpeedIndex(next: number): void {
    const index = Math.max(0, Math.min(SPEED_STEP_COUNT - 1, next));
    if (index === this.speedIndex) return;
    const session = this.session;
    if (session) {
      // Le cap bascule sur le rail du nouveau palier sans saut : l'écart s'efface en douceur.
      const current = this.resolveHeading(session, session.distanceM, 0);
      this.headingTrack = index;
      this.headingOffset = wrapPi(current - this.trackHeading(session, session.distanceM));
      this.headingBlendS = 0;
      this.headingBlendDurationS = headingBlendDurationS(this.headingOffset);
      session.transport.setMultiplier(FLYOVER_SPEED_STEPS[index]);
    }
    this.speedIndex = index;
    this.emitStatus(true);
  }

  private trackHeading(session: Session, distanceM: number): number {
    return sampleAt(session.rail.heading(this.headingTrack), distanceM / session.rail.spacingM);
  }

  private resolveHeading(session: Session, distanceM: number, dt: number): number {
    const base = this.trackHeading(session, distanceM);
    if (this.headingBlendS >= this.headingBlendDurationS) return base;
    this.headingBlendS += dt;
    return base + this.headingOffset * (1 - smootherstep(this.headingBlendS / this.headingBlendDurationS));
  }

  /* ── Boucle ────────────────────────────────────────────────────────── */

  private startLoop(): void {
    if (this.frameId) return;
    this.lastFrameTime = performance.now();
    this.frameId = window.requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (!this.frameId) return;
    window.cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  private readonly tick = (now: number) => {
    this.frameId = 0;
    const session = this.session;
    if (!session || !this.connected || !isMapAlive(this.map)) return;
    const dt = Math.min(MAX_FRAME_DT_S, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    if (this.phase === 'arriving') {
      this.arrivalHoldS += dt;
      if (this.arrivalHoldS >= ARRIVAL_HOLD_S) {
        this.beginOverview();
        return;
      }
    } else {
      session.transport.step(dt);
      const motion = session.transport.rate / Math.max(1e-6, session.transport.multiplierValue);
      this.orbitTimeS += dt * Math.max(0, Math.min(1, motion));
      this.updateHead(session, session.clock.distanceAt(session.transport.playbackTime));
    }

    this.applyFrame(session, dt);

    if (this.phase === 'handoff' && !this.handoff) this.setPhase('playing');
    if (this.phase === 'pausing' && session.transport.stopped) {
      this.enterPaused();
      this.emitCursor(true);
      return;
    }
    if (session.transport.arrived && this.phase !== 'arriving') {
      this.arrivalHoldS = 0;
      this.setPhase('arriving');
    }
    this.emitCursor(false);
    this.emitStatus(false);
    this.frameId = window.requestAnimationFrame(this.tick);
  };

  private computeFrame(session: Session, distanceM: number, dt: number) {
    const rail = session.rail;
    let fallbackAltitudeM = 0;
    if (!rail.hasElevation) {
      // Trace sans altitude : on vise le relief rendu, lissé pour ne pas suivre chaque pixel du MNT.
      const index = Math.min(rail.count - 1, distanceM / rail.spacingM);
      const ground = this.ground(sampleAt(rail.centerX, index), sampleAt(rail.centerY, index));
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
        speedMultiplier: session.transport.multiplierValue,
        headingRad: this.resolveHeading(session, distanceM, dt),
        orbitPhaseRad: (2 * Math.PI * this.orbitTimeS) / ORBIT_PERIOD_S,
        fovDistanceFactor: fovDistanceFactor(this.viewFovDeg()),
        exaggeration: this.exaggeration,
        fallbackTargetAltitudeM: fallbackAltitudeM,
      },
      this.frame,
    );
  }

  /** Champ de vision de la lecture (celui de Mapbox si on ne peut pas le régler). */
  private viewFovDeg(): number {
    return this.fov.supported ? FLYOVER_FOV_DEG : MAPBOX_DEFAULT_FOV_DEG;
  }

  private applyFrame(session: Session, dt: number): void {
    const rail = session.rail;
    const distanceM = session.distanceM;
    const frame = this.computeFrame(session, distanceM, dt);

    // Garde-relief : sol sous l'œil et ligne de visée vers la tête.
    const head = this.head;
    const headAltitudeM = rail.hasElevation ? head.elevationM * this.exaggeration : frame.targetAltitudeM;
    const behindIndex = Math.max(0, distanceM - frame.horizontalM) / rail.spacingM;
    const eyeGroundFallbackM = rail.hasElevation
      ? Math.max(sampleAt(rail.elevationM, behindIndex), head.elevationM) * this.exaggeration
      : frame.targetAltitudeM;
    const needed = requiredLift(frame, head.x, head.y, headAltitudeM, this.ground, eyeGroundFallbackM);
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
    applyCameraPose(this.map, pose);
  }

  /* ── Diffusion ─────────────────────────────────────────────────────── */

  private setPhase(phase: FlyoverPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitStatus(true);
  }

  private buildStatus(): FlyoverStatus {
    const route = this.input.route;
    const session = this.session;
    const multiplier = FLYOVER_SPEED_STEPS[this.speedIndex];
    const cachedRail = this.railCache && route && sameRoute(this.railCache.route, route) ? this.railCache.rail : null;
    const rail = session?.rail ?? cachedRail;
    const totalM = rail?.lengthM ?? (route ? route.distancesM[route.distancesM.length - 1] ?? 0 : 0);
    // Un rail déjà tenté et impossible (trace dégénérée) interdit la lecture.
    const railFailed = this.railCache != null && route != null && sameRoute(this.railCache.route, route) && this.railCache.rail == null;
    const canPlay = Boolean(route && route.points.length >= 2 && totalM > 1 && !railFailed);
    const durationAt1x = rail?.durationS ?? playbackDurationForLength(totalM);
    return {
      canPlay,
      phase: this.phase,
      isPlaying: this.isRunning(),
      playbackActive: session != null,
      speedIndex: this.speedIndex,
      distanceM: session ? session.distanceM : null,
      totalM,
      elapsedS: session ? session.transport.playbackTime / multiplier : 0,
      durationS: durationAt1x / multiplier,
    };
  }

  private emitStatus(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastStatusEmit < STATUS_EMIT_INTERVAL_MS) return;
    this.lastStatusEmit = now;
    this.status = this.buildStatus();
    for (const listener of this.statusListeners) listener();
  }

  private emitCursor(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastCursorEmit < CURSOR_EMIT_INTERVAL_MS) return;
    this.lastCursorEmit = now;
    const session = this.session;
    const toChartX = this.input.toChartX;
    const next = session && toChartX ? toChartX(session.distanceM) : null;
    const value = next != null && Number.isFinite(next) ? next : null;
    if (value === this.cursorX) return;
    this.cursorX = value;
    for (const listener of this.cursorListeners) listener();
  }
}
