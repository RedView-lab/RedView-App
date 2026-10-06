import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import type { MotionCamera, MotionChart, MotionFields, MotionPointer, MotionViewport } from '@/features/collab/protocol';
import type { CollabRealtime } from '@/features/collab/realtime';
import { getMapOverlayInsets, subscribeMapOverlayInsets } from '@/features/map3d/lib/mapOverlayInsets';

import {
  CAMERA_KEYFRAME_INTERVAL_MS,
  CURSOR_SEND_INTERVAL_MS,
  SETTLE_KEYFRAME_DELAY_MS,
  WATCHED_SEND_INTERVAL_MS,
} from '../config';
import { frameTimestamp } from '../lib/frameClock';
import { getLocalChartCursor, subscribeLocalChartCursor } from '../lib/localChartCursor';

/**
 * Émission de ce que cet éditeur voit et pointe (canal `motion`) : caméra et
 * zone visible de la carte, pointeur posé sur le relief, survol du graphique.
 *
 * Horodatage = instant où l'état envoyé est devenu vrai : l'image où la
 * caméra a bougé (son horodatage rAF, lib/frameClock), pas l'envoi — la
 * minuterie d'envoi passe après le rendu, parfois après une longue tâche, et
 * dater l'échantillon à l'envoi fausserait la vitesse rejouée chez celui qui
 * suit (à-coups). Une image clé sans changement est datée de l'envoi (l'état
 * tient toujours). Quand la carte rend, l'envoi part à la fin d'un rendu
 * (une image sur deux à 60 Hz : intervalles réguliers, délai d'envoi
 * constant, donc moins de gigue à couvrir chez celui qui suit) ; une
 * minuterie prend le relais sans rendu (pointeur seul). Cadence selon qui
 * regarde : 30 Hz pour tout si
 * quelqu'un me suit (ou si je présente), sinon le pointeur à 20 Hz et la
 * caméra en image clé ; rien au repos, rien sans autre éditeur. Un message
 * n'emporte que les flux changés depuis le dernier envoi ; 250 ms après
 * l'arrêt, un état complet répare une éventuelle perte. Sous contre-pression
 * (`canSendVolatile`), l'échantillon attend le suivant.
 */

type Stream = 'cam' | 'ptr' | 'chart';

/** Champ vertical par défaut de Mapbox (`transform.fov`, sans API publique). */
const DEFAULT_FOV_DEG = 36.87;
/** Sans le test de Mapbox : un pointeur reprojeté plus loin que ça de lui-même est dans le ciel. */
const HORIZON_FALLBACK_TOLERANCE_PX = 24;
/**
 * Envoi à la fin d'un rendu : une image un peu en avance sur la cadence part
 * quand même (60 Hz → une image sur deux, 144 Hz → une sur quatre).
 */
const FRAME_ALIGNED_TOLERANCE_MS = 6;
/** La carte a rendu il y a moins que ça : la minuterie de secours laisse passer l'image suivante. */
const RENDERING_RECENT_MS = 50;
const FRAME_GRACE_MS = 20;

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function sameArray(a: readonly unknown[] | null | undefined, b: readonly unknown[] | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export class PresenceBroadcaster {
  private readonly map: MapboxMap;
  private readonly realtime: CollabRealtime;
  private watched = false;
  private othersPresent = false;
  private readonly dirty = new Set<Stream>();
  private readonly lastSentAt: Record<Stream, number> = { cam: Number.NEGATIVE_INFINITY, ptr: Number.NEGATIVE_INFINITY, chart: Number.NEGATIVE_INFINITY };
  /** Instant (image) du dernier changement pas encore envoyé de chaque flux. */
  private readonly changedAt: Record<Stream, number | null> = { cam: null, ptr: null, chart: null };
  /** Horodatage du dernier message (strictement croissant : le récepteur repart de zéro sur un recul). */
  private lastSentT = Number.NEGATIVE_INFINITY;
  /** Dernières valeurs envoyées (un flux inchangé ne repart pas). */
  private sentCam: MotionCamera | null = null;
  private sentViewport: MotionViewport | null = null;
  private sentPtr: MotionPointer | null | undefined = undefined;
  private sentChart: MotionChart | null | undefined = undefined;
  /** Dernière position du pointeur sur la carte (px de mise en page), null hors de la carte. */
  private pointer: { x: number; y: number } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fin du dernier rendu de la carte (`performance.now()`). */
  private lastRenderAt = Number.NEGATIVE_INFINITY;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Dernier changement (l'image clé de repos part `SETTLE_KEYFRAME_DELAY_MS` après). */
  private lastDirtyAt = Number.NEGATIVE_INFINITY;
  private readonly disposers: Array<() => void> = [];

  constructor(map: MapboxMap, realtime: CollabRealtime) {
    this.map = map;
    this.realtime = realtime;
  }

  /** Branche les écoutes (carte, pointeur, graphique, onglet). */
  connect(): void {
    if (this.disposers.length > 0) return;
    const { map } = this;
    const onMove = () => {
      this.markDirty('cam');
      // La carte bouge sous une souris immobile : elle pointe autre chose.
      if (this.pointer) this.markDirty('ptr');
    };
    const onMouseMove = (event: MapMouseEvent) => {
      this.pointer = { x: event.point.x, y: event.point.y };
      this.markDirty('ptr');
    };
    const onMouseOut = () => {
      if (!this.pointer) return;
      this.pointer = null;
      this.markDirty('ptr');
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      // Onglet masqué : son curseur disparaît tout de suite chez les autres.
      this.pointer = null;
      this.dirty.add('ptr');
      this.flush(true);
    };
    const onRender = () => {
      this.lastRenderAt = performance.now();
      if (this.dirty.size > 0) this.flush(false, FRAME_ALIGNED_TOLERANCE_MS);
    };
    map.on('move', onMove);
    map.on('resize', onMove);
    map.on('render', onRender);
    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMouseOut);
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(
      () => map.off('move', onMove),
      () => map.off('resize', onMove),
      () => map.off('render', onRender),
      () => map.off('mousemove', onMouseMove),
      () => map.off('mouseout', onMouseOut),
      () => document.removeEventListener('visibilitychange', onVisibility),
      subscribeMapOverlayInsets(map, () => this.markDirty('cam')),
      subscribeLocalChartCursor(() => this.markDirty('chart')),
    );
  }

  /** Quelqu'un me suit, ou je présente : tout part à 30 Hz. */
  setWatched(watched: boolean): void {
    if (this.watched === watched) return;
    this.watched = watched;
    if (watched) this.sendKeyframe();
  }

  /** D'autres éditeurs sont là (sinon rien ne part). Un nouvel arrivant reçoit l'état complet. */
  setOthersPresent(present: boolean, someoneJoined = false): void {
    const was = this.othersPresent;
    this.othersPresent = present;
    if (present && (!was || someoneJoined)) this.sendKeyframe();
  }

  /** État complet tout de suite (session en ligne, quelqu'un commence à me suivre, nouvel arrivant). */
  sendKeyframe(): void {
    this.sentCam = null;
    this.sentViewport = null;
    this.sentPtr = undefined;
    this.sentChart = undefined;
    this.dirty.add('cam').add('ptr').add('chart');
    this.flush(true);
  }

  disconnect(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.flushTimer = null;
    this.settleTimer = null;
    this.othersPresent = false;
    this.watched = false;
    this.dirty.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private interval(stream: Stream): number {
    if (this.watched) return WATCHED_SEND_INTERVAL_MS;
    return stream === 'cam' ? CAMERA_KEYFRAME_INTERVAL_MS : CURSOR_SEND_INTERVAL_MS;
  }

  private markDirty(stream: Stream): void {
    if (!this.othersPresent) return;
    this.changedAt[stream] = frameTimestamp();
    this.dirty.add(stream);
    this.scheduleFlush();
    // Une minuterie pour toute la rafale (pas une par événement `move`, jusqu'à 144 par seconde).
    this.lastDirtyAt = performance.now();
    if (!this.settleTimer) this.scheduleSettle(SETTLE_KEYFRAME_DELAY_MS);
  }

  /** Image clé de repos `SETTLE_KEYFRAME_DELAY_MS` après le dernier changement. */
  private scheduleSettle(delayMs: number): void {
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const sinceLastChange = performance.now() - this.lastDirtyAt;
      if (sinceLastChange < SETTLE_KEYFRAME_DELAY_MS) this.scheduleSettle(SETTLE_KEYFRAME_DELAY_MS - sinceLastChange);
      else this.sendKeyframe();
    }, delayMs);
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.dirty.size === 0) return;
    const now = performance.now();
    let wait = Number.POSITIVE_INFINITY;
    for (const stream of this.dirty) wait = Math.min(wait, this.lastSentAt[stream] + this.interval(stream) - now);
    // Carte en train de rendre : l'envoi part avec une image (onRender), la minuterie n'est qu'un secours.
    if (now - this.lastRenderAt < RENDERING_RECENT_MS) wait += FRAME_GRACE_MS;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush(false);
    }, Math.max(0, wait));
  }

  /** Envoie les flux changés dont la cadence le permet (`force` : tous ; `toleranceMs` : avance permise sur la cadence). */
  private flush(force: boolean, toleranceMs = 1): void {
    if (!this.othersPresent || this.dirty.size === 0) return;
    if (!this.realtime.canSendVolatile()) {
      // Connexion encombrée (gros lot en cours) : on réessaie au prochain intervalle.
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = null;
        this.flush(force);
      }, WATCHED_SEND_INTERVAL_MS);
      return;
    }
    const now = performance.now();
    const due = (stream: Stream) => this.dirty.has(stream) && (force || now - this.lastSentAt[stream] >= this.interval(stream) - toleranceMs);
    const fields: MotionFields = {};
    const sent: Stream[] = [];

    if (due('cam')) {
      this.dirty.delete('cam');
      const camera = this.readCamera();
      const viewport = this.readViewport();
      if (camera && viewport && (!sameArray(camera, this.sentCam) || !sameArray(viewport, this.sentViewport))) {
        fields.cam = camera;
        fields.vp = viewport;
        sent.push('cam');
      } else {
        this.changedAt.cam = null;
      }
    }
    if (due('ptr')) {
      this.dirty.delete('ptr');
      const pointer = this.readPointer();
      if (this.sentPtr === undefined || !sameArray(pointer, this.sentPtr)) {
        fields.ptr = pointer;
        sent.push('ptr');
      } else {
        this.changedAt.ptr = null;
      }
    }
    if (due('chart')) {
      this.dirty.delete('chart');
      const cursor = getLocalChartCursor();
      const chart: MotionChart | null = cursor ? [cursor.itineraryId, round(cursor.distanceM, 1)] : null;
      if (this.sentChart === undefined || !sameArray(chart, this.sentChart)) {
        fields.chart = chart;
        sent.push('chart');
      } else {
        this.changedAt.chart = null;
      }
    }

    if (sent.length === 0) {
      this.scheduleFlush();
      return;
    }
    // Instant où cet état est devenu vrai (le plus récent des changements envoyés) ; image clé sans changement : maintenant.
    let stamp = Number.NEGATIVE_INFINITY;
    for (const stream of sent) stamp = Math.max(stamp, this.changedAt[stream] ?? Number.NEGATIVE_INFINITY);
    let t = round(Number.isFinite(stamp) ? Math.min(stamp, now) : now, 1);
    if (t <= this.lastSentT) t = round(this.lastSentT + 0.1, 1);
    if (this.realtime.sendMotion(t, fields)) {
      this.lastSentT = t;
      for (const stream of sent) {
        this.lastSentAt[stream] = now;
        this.changedAt[stream] = null;
      }
      if (fields.cam) {
        this.sentCam = fields.cam;
        this.sentViewport = fields.vp ?? this.sentViewport;
      }
      if (fields.ptr !== undefined) this.sentPtr = fields.ptr;
      if (fields.chart !== undefined) this.sentChart = fields.chart;
    }
    this.scheduleFlush();
  }

  private readCamera(): MotionCamera | null {
    try {
      const center = this.map.getCenter();
      const fov = (this.map as unknown as { transform?: { fov?: number } }).transform?.fov;
      const camera: MotionCamera = [
        round(center.lng, 7),
        round(center.lat, 7),
        round(this.map.getZoom(), 4),
        round(this.map.getBearing(), 2),
        round(this.map.getPitch(), 2),
        round(typeof fov === 'number' && Number.isFinite(fov) ? fov : DEFAULT_FOV_DEG, 2),
      ];
      return camera.every(Number.isFinite) ? camera : null;
    } catch {
      return null;
    }
  }

  private readViewport(): MotionViewport | null {
    const container = this.map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!(width > 0 && height > 0)) return null;
    const insets = getMapOverlayInsets(this.map);
    const padding = this.map.getPadding();
    return [
      width,
      height,
      Math.round(insets.top),
      Math.round(insets.right),
      Math.round(insets.bottom),
      Math.round(insets.left),
      Math.round(padding.top ?? 0),
      Math.round(padding.right ?? 0),
      Math.round(padding.bottom ?? 0),
      Math.round(padding.left ?? 0),
    ];
  }

  /** Point du relief sous le pointeur ; null hors de la carte, dans le ciel ou onglet masqué. */
  private readPointer(): MotionPointer | null {
    const pointer = this.pointer;
    if (!pointer || document.visibilityState === 'hidden') return null;
    try {
      if (this.isAboveHorizon(pointer)) return null;
      const lngLat = this.map.unproject([pointer.x, pointer.y]);
      const point: MotionPointer = [round(lngLat.lng, 7), round(lngLat.lat, 7)];
      return point.every(Number.isFinite) ? point : null;
    } catch {
      return null;
    }
  }

  /**
   * Pointeur dans le ciel (rien sous lui) : test de Mapbox (lancer de rayon
   * sur le relief) quand il est là. Sinon, aller-retour `unproject` →
   * `project` : sur le relief il s'écarte de quelques px (précision du lancer
   * de rayon), dans le ciel le point revient sur l'horizon, loin.
   */
  private isAboveHorizon(pointer: { x: number; y: number }): boolean {
    const transform = (this.map as unknown as { transform?: { isPointAboveHorizon?: (point: { x: number; y: number }) => boolean } }).transform;
    if (typeof transform?.isPointAboveHorizon === 'function') return transform.isPointAboveHorizon({ x: pointer.x, y: pointer.y });
    const back = this.map.project(this.map.unproject([pointer.x, pointer.y]));
    return Math.hypot(back.x - pointer.x, back.y - pointer.y) > HORIZON_FALLBACK_TOLERANCE_PX;
  }
}
