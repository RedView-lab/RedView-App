import type { Map as MapboxMap } from 'mapbox-gl';

import { isFreeCamEvent } from '@/features/freeCam/lib/eventData';
import { isFreeCamActive, requestFreeCamExit, subscribeFreeCam } from '@/features/freeCam/lib/freeCamRuntime';
import { batchDrivenCameraEvents, type CameraEventBatch } from '@/features/map3d/lib/cameraEventBatch';
import { computeAdaptiveFlightDuration, haversineDistanceKm } from '@/features/map3d/lib/cameraFlight';
import { getCameraOwner, setCameraOwner, subscribeCameraOwner } from '@/features/map3d/lib/cameraOwnership';
import { getMapOverlayInsets, subscribeMapOverlayInsets } from '@/features/map3d/lib/mapOverlayInsets';

import { FOLLOW_BLEND_MS, FOLLOW_FLY_MIN_SCREENS, FOLLOW_FLY_MIN_ZOOM_DELTA } from '../config';
import { cameraFromWire, followCamera, viewportFromWire, type FollowCamera, type Insets } from '../lib/followCamera';
import { normalizeAngle } from '../lib/playout';
import type { MotionStore } from './MotionStore';

/**
 * Suivre un autre éditeur (mode observation de Figma) : sa caméra rejouée en
 * différé (MotionStore), cadrée « contain » dans ma carte (lib/followCamera).
 *
 *  - Démarrage : vol de van Wijk (`flyTo`) si sa vue est loin, puis fondu de
 *    raccord vers sa caméra du moment (il a pu bouger pendant le vol).
 *  - Ensuite, à chaque image Mapbox : la caméra est posée au début du rendu
 *    (file de rendu de Mapbox, comme ses propres animations : carte,
 *    marqueurs et curseurs dans la même image), événements caméra regroupés
 *    comme une animation (un *start, un *end). Au repos (dernier échantillon
 *    atteint), la boucle s'arrête : rien ne touche la carte.
 *  - Arrêt dès que l'utilisateur touche la carte (clic, molette, toucher,
 *    clavier de la carte), qu'un autre mouvement de caméra part (bouton de
 *    zoom, recherche, « voir sur la carte »…), à Échap, à la FreeCam ou au
 *    flyover.
 */

export type FollowStopReason = 'interaction' | 'camera' | 'escape' | 'freecam' | 'flyover' | 'request';

export interface FollowControllerOptions {
  /** Suivi arrêté par l'utilisateur ou un autre pilote de caméra. */
  onStop(reason: FollowStopReason): void;
}

type Phase = 'waiting' | 'flying' | 'blending' | 'live';

const FOLLOW_MARKER = 'follow';
const FOLLOW_EVENT_DATA = { [FOLLOW_MARKER]: true } as const;
const DEFAULT_FOV_DEG = 36.87;
/** Fin de rafale : plus de nouvelle image depuis ce délai → les *end partent (sauvegarde du viewport…). */
const BATCH_IDLE_RELEASE_MS = 200;

interface RenderFrameMap {
  _requestRenderFrame?: (callback: (paintStartTimeStamp: number) => void) => number;
  _cancelRenderFrame?: (id: number) => void;
  transform?: { fov?: number };
}

function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + normalizeAngle(b - a) * t;
}

function blendCameras(from: FollowCamera, to: FollowCamera, t: number): FollowCamera {
  const lerpInsets = (a: Insets, b: Insets): Insets => ({
    top: lerp(a.top, b.top, t),
    right: lerp(a.right, b.right, t),
    bottom: lerp(a.bottom, b.bottom, t),
    left: lerp(a.left, b.left, t),
  });
  return {
    center: [lerpAngle(from.center[0], to.center[0], t), lerp(from.center[1], to.center[1], t)],
    zoom: lerp(from.zoom, to.zoom, t),
    bearing: lerpAngle(from.bearing, to.bearing, t),
    pitch: lerp(from.pitch, to.pitch, t),
    fov: lerp(from.fov, to.fov, t),
    padding: lerpInsets(from.padding, to.padding),
  };
}

function sameCamera(a: FollowCamera | null, b: FollowCamera): boolean {
  if (!a) return false;
  return Math.abs(a.center[0] - b.center[0]) < 1e-9
    && Math.abs(a.center[1] - b.center[1]) < 1e-9
    && Math.abs(a.zoom - b.zoom) < 1e-6
    && Math.abs(normalizeAngle(a.bearing - b.bearing)) < 1e-4
    && Math.abs(a.pitch - b.pitch) < 1e-4
    && Math.abs(a.fov - b.fov) < 1e-4
    && Math.abs(a.padding.top - b.padding.top) < 0.01
    && Math.abs(a.padding.right - b.padding.right) < 0.01
    && Math.abs(a.padding.bottom - b.padding.bottom) < 0.01
    && Math.abs(a.padding.left - b.padding.left) < 0.01;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== 'function') return false;
  return !!element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

export class FollowController {
  private readonly map: MapboxMap;
  private readonly store: MotionStore;
  private readonly options: FollowControllerOptions;
  private targetClientId: string | null = null;
  private phase: Phase = 'waiting';
  private blendFrom: FollowCamera | null = null;
  private blendStartedAt: number | null = null;
  private lastApplied: FollowCamera | null = null;
  private frameId: number | null = null;
  private frameIsRender = false;
  private batch: CameraEventBatch | null = null;
  private batchReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private originalFov: number | null = null;
  private resizing = false;
  private readonly disposers: Array<() => void> = [];

  constructor(map: MapboxMap, store: MotionStore, options: FollowControllerOptions) {
    this.map = map;
    this.store = store;
    this.options = options;
  }

  get target(): string | null {
    return this.targetClientId;
  }

  /** Commence à suivre `clientId` (ou passe à lui : autre onglet du même utilisateur, chaîne qui change). */
  start(clientId: string): void {
    if (this.targetClientId === clientId) return;
    const switching = this.targetClientId !== null;
    this.targetClientId = clientId;
    if (!switching) this.takeCamera();
    // Vers la nouvelle cible : vol si elle est loin, sinon fondu depuis la vue actuelle.
    this.phase = 'waiting';
    this.requestFrame();
  }

  /** Arrêt demandé par l'application (bouton, départ de l'éditeur suivi…) : pas de rappel `onStop`. */
  stop(): void {
    this.release();
  }

  dispose(): void {
    this.release();
  }

  /* ── Caméra ─────────────────────────────────────────────────────────── */

  private takeCamera(): void {
    if (isFreeCamActive()) requestFreeCamExit();
    // Un mouvement encore en cours (inertie d'un glisser, zoom à la molette
    // qui finit) émettrait son prochain `movestart` et arrêterait le suivi.
    try {
      this.map.stop();
    } catch {
      /* carte détruite */
    }
    setCameraOwner('follow');
    const container = this.map.getCanvasContainer();
    const onInput = () => this.userStop('interaction');
    container.addEventListener('pointerdown', onInput, true);
    container.addEventListener('wheel', onInput, { capture: true, passive: true });
    container.addEventListener('touchstart', onInput, { capture: true, passive: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      this.userStop('escape');
    };
    window.addEventListener('keydown', onKeyDown, true);
    const onMoveStart = (event: object) => {
      // Les nôtres ; ceux de la FreeCam qui se referme au démarrage (son activation, elle, arrête le suivi).
      if ((event as Record<string, unknown>)[FOLLOW_MARKER] === true || isFreeCamEvent(event)) return;
      // Venu d'un geste de souris, de doigt ou de molette : un geste pendant le
      // suivi l'a déjà arrêté à sa source (écoutes en capture ci-dessus) ; sinon
      // c'est la fin d'un geste d'avant le suivi (inertie, zoom qui finit).
      // Restent : le clavier de la carte, et les mouvements lancés par l'application.
      const original = (event as { originalEvent?: unknown }).originalEvent;
      if (original && !(typeof KeyboardEvent !== 'undefined' && original instanceof KeyboardEvent)) return;
      // `resize()` émet movestart → move → resize → moveend d'un trait : pas un mouvement de caméra.
      this.resizing = false;
      queueMicrotask(() => {
        if (!this.resizing) this.userStop('camera');
      });
    };
    const onResize = () => {
      this.resizing = true;
      this.requestFrame();
    };
    this.map.on('movestart', onMoveStart);
    this.map.on('resize', onResize);
    this.disposers.push(
      () => container.removeEventListener('pointerdown', onInput, true),
      () => container.removeEventListener('wheel', onInput, { capture: true }),
      () => container.removeEventListener('touchstart', onInput, { capture: true }),
      () => window.removeEventListener('keydown', onKeyDown, true),
      () => this.map.off('movestart', onMoveStart),
      () => this.map.off('resize', onResize),
      subscribeFreeCam((active) => {
        if (active) this.userStop('freecam');
      }),
      subscribeCameraOwner((owner) => {
        if (owner !== 'follow') this.userStop('flyover');
      }),
      subscribeMapOverlayInsets(this.map, () => this.requestFrame()),
      this.store.subscribe((clientId) => {
        if (clientId === this.targetClientId) this.requestFrame();
      }),
    );
  }

  private userStop(reason: FollowStopReason): void {
    if (!this.targetClientId) return;
    this.release();
    this.options.onStop(reason);
  }

  private release(): void {
    if (!this.targetClientId) return;
    this.targetClientId = null;
    this.cancelFrame();
    if (this.batchReleaseTimer) clearTimeout(this.batchReleaseTimer);
    this.batchReleaseTimer = null;
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.phase === 'flying') {
      try {
        this.map.stop();
      } catch {
        /* carte détruite */
      }
    }
    this.releaseBatch();
    this.restoreFov();
    this.phase = 'waiting';
    this.blendFrom = null;
    this.lastApplied = null;
    if (getCameraOwner() === 'follow') setCameraOwner(null);
  }

  /* ── Boucle ─────────────────────────────────────────────────────────── */

  private requestFrame(): void {
    if (this.frameId !== null || !this.targetClientId) return;
    const renderMap = this.map as unknown as RenderFrameMap;
    if (typeof renderMap._requestRenderFrame === 'function') {
      // Au début du prochain rendu de Mapbox : caméra posée et dessinée dans la même image.
      this.frameIsRender = true;
      this.frameId = renderMap._requestRenderFrame((now) => {
        this.frameId = null;
        this.step(now);
      });
    } else {
      this.frameIsRender = false;
      this.frameId = window.requestAnimationFrame((now) => {
        this.frameId = null;
        this.step(now);
      });
    }
  }

  private cancelFrame(): void {
    if (this.frameId === null) return;
    const renderMap = this.map as unknown as RenderFrameMap;
    if (this.frameIsRender) renderMap._cancelRenderFrame?.(this.frameId);
    else window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private step(now: number): void {
    const clientId = this.targetClientId;
    if (!clientId || this.phase === 'flying') return;
    const frame = this.store.frame(clientId, now);
    const desired = this.desiredCamera(frame?.cam?.values ?? null, frame?.cam?.payload ?? null);
    if (!desired) {
      // Rien encore de lui : on attend son premier échantillon (le store réveille la boucle).
      return;
    }
    if (this.phase === 'waiting') {
      if (this.shouldFly(desired)) {
        this.fly(desired);
        return;
      }
      this.beginBlend(now);
    }
    let camera = desired;
    let blending = false;
    if (this.phase === 'blending' && this.blendFrom && this.blendStartedAt !== null) {
      const t = (now - this.blendStartedAt) / FOLLOW_BLEND_MS;
      if (t < 1) {
        camera = blendCameras(this.blendFrom, desired, smootherstep(t));
        blending = true;
      } else {
        this.phase = 'live';
        this.blendFrom = null;
      }
    }
    this.apply(camera);
    // Seule sa caméra fait tourner la boucle (chaque image demandée redessine la
    // carte) : son curseur qui bouge est l'affaire du calque des curseurs.
    if (blending || !(frame?.cam?.settled ?? true)) this.requestFrame();
    else this.scheduleBatchRelease();
  }

  private desiredCamera(values: number[] | null, viewport: readonly number[] | null): FollowCamera | null {
    if (!values || !viewport) return null;
    const container = this.map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!(width > 0 && height > 0)) return null;
    return followCamera(
      cameraFromWire(values),
      viewportFromWire(viewport),
      { width, height, insets: getMapOverlayInsets(this.map) },
      { minZoom: this.map.getMinZoom(), maxZoom: this.map.getMaxZoom() },
    );
  }

  /** Vue loin de la sienne (hors de ≈ 1,5 écran ou 2 niveaux de zoom) : on y vole. */
  private shouldFly(desired: FollowCamera): boolean {
    if (Math.abs(this.map.getZoom() - desired.zoom) > FOLLOW_FLY_MIN_ZOOM_DELTA) return true;
    try {
      const point = this.map.project(desired.center);
      const container = this.map.getContainer();
      const size = Math.max(container.clientWidth, container.clientHeight);
      const dx = point.x - container.clientWidth / 2;
      const dy = point.y - container.clientHeight / 2;
      return !Number.isFinite(dx) || Math.hypot(dx, dy) > size * FOLLOW_FLY_MIN_SCREENS;
    } catch {
      return true;
    }
  }

  private fly(desired: FollowCamera): void {
    this.phase = 'flying';
    const center = this.map.getCenter();
    const distanceKm = haversineDistanceKm(center.lat, center.lng, desired.center[1], desired.center[0]);
    const onEnd = (event: object) => {
      if ((event as Record<string, unknown>)[FOLLOW_MARKER] !== true || this.phase !== 'flying') return;
      this.map.off('moveend', onEnd);
      this.phase = 'waiting';
      this.beginBlend(performance.now());
      this.requestFrame();
    };
    this.applyFov(desired.fov);
    this.map.flyTo({
      center: desired.center,
      zoom: desired.zoom,
      bearing: desired.bearing,
      pitch: desired.pitch,
      padding: desired.padding,
      duration: computeAdaptiveFlightDuration(distanceKm),
      curve: 1.42,
      essential: true,
    }, FOLLOW_EVENT_DATA);
    // Après le départ : un vol précédent interrompu émet son `moveend` pendant l'appel à `flyTo`.
    this.map.on('moveend', onEnd);
    this.disposers.push(() => this.map.off('moveend', onEnd));
  }

  /** Raccord : de la vue actuelle vers la sienne, en `FOLLOW_BLEND_MS`. */
  private beginBlend(now: number): void {
    this.phase = 'blending';
    this.blendStartedAt = now;
    this.blendFrom = this.currentCamera();
  }

  private currentCamera(): FollowCamera {
    const center = this.map.getCenter();
    const padding = this.map.getPadding();
    return {
      center: [center.lng, center.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      fov: this.readFov(),
      padding: { top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0 },
    };
  }

  private apply(camera: FollowCamera): void {
    if (sameCamera(this.lastApplied, camera)) return;
    if (!this.batch) this.batch = batchDrivenCameraEvents(this.map, FOLLOW_MARKER);
    if (this.batchReleaseTimer) {
      clearTimeout(this.batchReleaseTimer);
      this.batchReleaseTimer = null;
    }
    this.applyFov(camera.fov);
    try {
      this.map.jumpTo({
        center: camera.center,
        zoom: camera.zoom,
        bearing: camera.bearing,
        pitch: camera.pitch,
        padding: camera.padding,
      }, FOLLOW_EVENT_DATA);
      this.lastApplied = camera;
    } catch {
      /* style en cours de remplacement : l'image suivante réessaie */
    }
  }

  /** Au repos : les fins de mouvement partent une fois (comme à la fin d'une animation). */
  private scheduleBatchRelease(): void {
    if (!this.batch || this.batchReleaseTimer) return;
    this.batchReleaseTimer = setTimeout(() => {
      this.batchReleaseTimer = null;
      if (this.frameId === null) this.releaseBatch();
    }, BATCH_IDLE_RELEASE_MS);
  }

  private releaseBatch(): void {
    this.batch?.release();
    this.batch = null;
  }

  /* ── Champ vertical (flyover de l'éditeur suivi : 44°) ─────────────── */

  private readFov(): number {
    const fov = (this.map as unknown as RenderFrameMap).transform?.fov;
    return typeof fov === 'number' && Number.isFinite(fov) ? fov : DEFAULT_FOV_DEG;
  }

  private applyFov(fov: number): void {
    const transform = (this.map as unknown as RenderFrameMap).transform;
    if (!transform || typeof transform.fov !== 'number' || Math.abs(transform.fov - fov) < 1e-3) return;
    if (this.originalFov === null) this.originalFov = transform.fov;
    transform.fov = fov;
  }

  private restoreFov(): void {
    const transform = (this.map as unknown as RenderFrameMap).transform;
    if (this.originalFov !== null && transform && typeof transform.fov === 'number') {
      try {
        transform.fov = this.originalFov;
        this.map.triggerRepaint();
      } catch {
        /* carte détruite */
      }
    }
    this.originalFov = null;
  }
}
