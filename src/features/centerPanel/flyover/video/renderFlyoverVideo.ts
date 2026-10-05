import type { Map as MapboxMap } from 'mapbox-gl';
import { buildCameraRail } from '../engine/cameraRail';
import { landscapeFraming, portraitFraming, type FlyoverFraming } from '../engine/framing';
import { buildRouteTrack } from '../engine/routeTrack';
import type { FlyoverRouteInput } from '../types';
import { FrameCompositor } from './compositor';
import {
  PRELOAD_AHEAD_S,
  PRELOAD_EVERY_FRAMES,
  PRELOAD_WARMUP_MAX_MS,
  PRELOAD_WARMUP_S,
  PRELOAD_WARMUP_STEP_S,
  VIDEO_FPS,
  VIDEO_SIZES,
  VIDEO_SUPERSAMPLING,
  type FlyoverVideoOrientation,
} from './config';
import { FlyoverVideoDirector, type VideoCamera, type VideoShot } from './director';
import { canEncodeFlyoverVideo, createVideoEncoderSink, type VideoEncoderSink } from './encoder';
import { VideoMap } from './videoMap';

export interface FlyoverVideoRequest {
  liveMap: MapboxMap;
  route: FlyoverRouteInput;
  /** Palier de vitesse du flyover (`FLYOVER_SPEED_STEPS`) : la vidéo dure ce que dure la lecture à ce palier. */
  speedIndex: number;
  orientation: FlyoverVideoOrientation;
}

export type FlyoverVideoPhase = 'preparing' | 'rendering' | 'finalizing';

export interface FlyoverVideoProgress {
  phase: FlyoverVideoPhase;
  frame: number;
  totalFrames: number;
  /** Avancement global, 0 → 1. */
  fraction: number;
  /** Temps restant estimé (s), `null` tant qu'il n'est pas mesurable. */
  etaS: number | null;
  /** Durée de la vidéo (s), connue une fois la carte prête. */
  videoDurationS: number | null;
}

export interface FlyoverVideoResult {
  blob: Blob;
  durationS: number;
  frames: number;
  /** Images prises avant que toutes leurs tuiles soient arrivées (délai dépassé). */
  incompleteFrames: number;
  elapsedS: number;
}

export interface FlyoverVideoCallbacks {
  signal: AbortSignal;
  onProgress?: (progress: FlyoverVideoProgress) => void;
}

export class FlyoverVideoUnsupportedError extends Error {
  constructor() {
    super("Ce navigateur ne sait pas encoder de vidéo H.264 (WebCodecs). Utilisez Chrome, Edge ou Safari récent.");
    this.name = 'FlyoverVideoUnsupportedError';
  }
}

const PROGRESS_INTERVAL_MS = 200;
/** Part de la barre d'avancement prise par la préparation et par la finalisation. */
const PREPARE_SHARE = 0.12;
const FINALIZE_SHARE = 0.02;

function framingFor(orientation: FlyoverVideoOrientation): FlyoverFraming {
  return orientation === 'portrait' ? portraitFraming() : landscapeFraming();
}

function copyCamera(camera: VideoCamera): VideoCamera {
  return camera.kind === 'view' ? { kind: 'view', view: { ...camera.view } } : { kind: 'pose', pose: { ...camera.pose } };
}

/**
 * Directeur « éclaireur » : le même montage, quelques secondes en avance,
 * pour précharger les tuiles des poses à venir. Ses poses sont des
 * approximations (relief connu à l'image courante) : elles servent à choisir
 * des tuiles, pas à être rendues.
 */
class ShotScout {
  private readonly director: FlyoverVideoDirector;
  private readonly cameras = new Map<number, VideoCamera>();
  private reached = -1;

  constructor(director: FlyoverVideoDirector) {
    this.director = director;
  }

  /** Caméras des images `indices` (calculées au besoin), les plus anciennes oubliées. */
  camerasAt(indices: readonly number[], forgetBefore: number): VideoCamera[] {
    const last = Math.max(...indices);
    while (this.reached < last) {
      const shot = this.director.next();
      if (!shot) break;
      this.reached = shot.index;
      this.cameras.set(shot.index, copyCamera(shot.camera));
    }
    for (const index of this.cameras.keys()) if (index < forgetBefore) this.cameras.delete(index);
    return indices.map((index) => this.cameras.get(index)).filter((camera): camera is VideoCamera => camera != null);
  }
}

/**
 * Rend le flyover de l'itinéraire en MP4 : carte hors écran à la taille de
 * la vidéo, suréchantillonnée, chaque image prise une fois tout chargé,
 * encodée en H.264 au fil de l'eau. Rien n'est filmé à l'écran ; la carte de
 * l'utilisateur reste libre.
 */
export async function renderFlyoverVideo(request: FlyoverVideoRequest, callbacks: FlyoverVideoCallbacks): Promise<FlyoverVideoResult> {
  const { signal, onProgress } = callbacks;
  const startedAt = performance.now();
  const { width, height } = VIDEO_SIZES[request.orientation];
  const fps = VIDEO_FPS;
  const report = (progress: FlyoverVideoProgress) => onProgress?.(progress);
  report({ phase: 'preparing', frame: 0, totalFrames: 0, fraction: 0, etaS: null, videoDurationS: null });

  if (!(await canEncodeFlyoverVideo(width, height, fps))) throw new FlyoverVideoUnsupportedError();
  const track = buildRouteTrack(request.route.points, request.route.distancesM);
  if (!track) throw new Error("L'itinéraire n'a pas de tracé exploitable pour une vidéo.");
  const framing = framingFor(request.orientation);
  const rail = buildCameraRail(track, undefined, framing.centerlineMaxOffsetPerDistance);

  const videoMap = await VideoMap.create({
    liveMap: request.liveMap,
    width,
    height,
    pixelRatio: VIDEO_SUPERSAMPLING,
    fovDeg: framing.fovDeg,
    route: request.route,
    signal,
  });
  let encoder: VideoEncoderSink | null = null;
  try {
    const directorOptions = {
      rail,
      framing,
      aspect: width / height,
      fps,
      speedIndex: request.speedIndex,
      map: videoMap.directorMap(),
    };
    const director = new FlyoverVideoDirector(directorOptions);
    const scout = new ShotScout(new FlyoverVideoDirector(directorOptions));
    const totalFrames = director.totalFrames;
    const videoDurationS = director.durationS;

    // Première vue posée et tuiles des premières secondes téléchargées avant la première image.
    videoMap.applyView(director.firstView);
    const warmup: number[] = [];
    for (let s = 0; s <= PRELOAD_WARMUP_S; s += PRELOAD_WARMUP_STEP_S) warmup.push(Math.min(totalFrames - 1, Math.round(s * fps)));
    await videoMap.warmUp(scout.camerasAt(warmup, 0), signal, PRELOAD_WARMUP_MAX_MS, (fraction) =>
      report({
        phase: 'preparing',
        frame: 0,
        totalFrames,
        fraction: PREPARE_SHARE * Math.min(1, fraction),
        etaS: null,
        videoDurationS,
      }),
    );

    const compositor = new FrameCompositor(width, height, {
      color: request.route.color,
      attribution: videoMap.attributionText(),
    });
    await compositor.loadLogo(videoMap.logoUrl());
    encoder = await createVideoEncoderSink(compositor.canvas, fps);

    const aheadFrames = PRELOAD_AHEAD_S.map((s) => Math.round(s * fps));
    let incompleteFrames = 0;
    let encodeMs = 0;
    const slowest = { ms: 0, index: -1, segment: '' };
    let lastProgressAt = 0;
    const renderStartedAt = performance.now();
    let shot: VideoShot | null;
    while ((shot = director.next())) {
      if (signal.aborted) throw new DOMException('Export annulé', 'AbortError');
      const index = shot.index;
      if (index % PRELOAD_EVERY_FRAMES === 0) {
        const indices = aheadFrames.map((ahead) => Math.min(totalFrames - 1, index + ahead));
        videoMap.preload(scout.camerasAt(indices, index));
      }
      videoMap.applyShot(shot);
      const head = shot.head;
      const frameStart = performance.now();
      const complete = await videoMap.renderSettled((canvas) => {
        compositor.draw(canvas, videoMap.project(head.lng, head.lat));
      }, signal);
      const frameMs = performance.now() - frameStart;
      if (frameMs > slowest.ms) Object.assign(slowest, { ms: frameMs, index, segment: shot.segment });
      if (!complete) {
        incompleteFrames += 1;
        if (incompleteFrames <= 3) console.warn(`[flyover-video] image ${index} (${shot.segment}) incomplète`);
      }
      if (index === 0 || index % (fps * 2) === 0) compositor.setAttribution(videoMap.attributionText());
      const encodeStart = performance.now();
      await encoder.add(index);
      encodeMs += performance.now() - encodeStart;

      const now = performance.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || index === totalFrames - 1) {
        lastProgressAt = now;
        const done = index + 1;
        const perFrameMs = (now - renderStartedAt) / done;
        report({
          phase: 'rendering',
          frame: done,
          totalFrames,
          fraction: PREPARE_SHARE + (1 - PREPARE_SHARE - FINALIZE_SHARE) * (done / totalFrames),
          etaS: done >= 15 ? ((totalFrames - done) * perFrameMs) / 1000 : null,
          videoDurationS,
        });
      }
    }

    report({ phase: 'finalizing', frame: totalFrames, totalFrames, fraction: 1 - FINALIZE_SHARE, etaS: null, videoDurationS });
    const blob = await encoder.finish();
    encoder = null;
    const { renders, renderMs, waitMs, waitBySource } = videoMap.stats;
    const waits = [...waitBySource]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id, ms]) => `${id} ${(ms / 1000).toFixed(1)} s`)
      .join(', ');
    const renderLoopS = (performance.now() - renderStartedAt) / 1000;
    console.info(
      `[flyover-video] ${totalFrames} images en ${renderLoopS.toFixed(1)} s (${(totalFrames / renderLoopS).toFixed(1)} i/s) : ` +
        `${renders} rendus (${(renderMs / Math.max(1, renders)).toFixed(1)} ms/rendu), attente tuiles ${(waitMs / 1000).toFixed(1)} s` +
        `${waits ? ` (${waits})` : ''}, ` +
        `encodage ${(encodeMs / 1000).toFixed(1)} s, ${(blob.size / 1_048_576).toFixed(1)} Mo ; ` +
        `image la plus lente ${slowest.index} (${slowest.segment}) ${(slowest.ms / 1000).toFixed(1)} s`,
    );
    if (incompleteFrames > 0) {
      console.warn(`[flyover-video] ${incompleteFrames} image(s) prise(s) avant la fin du chargement de leurs tuiles`);
    }
    return {
      blob,
      durationS: videoDurationS,
      frames: totalFrames,
      incompleteFrames,
      elapsedS: (performance.now() - startedAt) / 1000,
    };
  } finally {
    if (encoder) await encoder.cancel();
    videoMap.destroy();
  }
}
