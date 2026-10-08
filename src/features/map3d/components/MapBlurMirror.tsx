import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

const SETTLE_AFTER_MOVE_MS = 250;
const MIRROR_SCALE = 0.5; // 50 % de résolution (p. ex. 190x450 px) = détails nets sans pixelisation sur AMD Ryzen

interface MirrorFrameProfile {
  activeFrameMs: number;
  idleFrameMs: number;
}

interface MirrorInstance {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  activeBlur: number;
  activeSaturate: number;
  blur: number;
  saturate: number;
  frameProfile: MirrorFrameProfile;
  cachedTargetRect: DOMRect | null;
  lastDrawAt: number;
  applyPresentation: (moving: boolean) => void;
}

const mapBlurMirrorSchedulers = new WeakMap<MapboxMap, MapBlurMirrorScheduler>();

function getMirrorFrameProfile(): MirrorFrameProfile {
  // 14 images/s pendant un mouvement de caméra restent parfaitement fluides pour
  // un fond très flouté, tout en économisant plus de 80 % des copies GPU sur les
  // GPU intégrés AMD Radeon.
  const activeFps = 14;

  return {
    activeFrameMs: 1000 / activeFps,
    idleFrameMs: Number.POSITIVE_INFINITY,
  };
}

/**
 * Copie des régions du canvas Mapbox dans de petits canvas 2D floutés.
 *
 * Les pixels de la carte sont lus de façon synchrone dans l'événement `render`
 * de la carte, pendant que le tampon de dessin WebGL est encore valide. La carte
 * peut ainsi tourner avec `preserveDrawingBuffer: false`, ce qui évite une copie
 * plein écran du tampon à chaque image (très coûteuse sur les GPU Apple à tuiles
 * / ANGLE-Metal et sur les iGPU).
 *
 * Chaque lecture rafraîchit un instantané 2D réduit de toute la carte ; les
 * miroirs sont découpés dans cet instantané. Un simple changement de géométrie
 * (redimensionnement / glissement d'un panneau, 60 événements/s) ne fait donc
 * que redécouper l'instantané à l'image d'animation suivante — sans repeindre la
 * carte. Une vraie image de carte n'est demandée que lorsque l'image de la carte
 * a pu changer (début / fin de mouvement, redimensionnement du canvas de la
 * carte, onglet affiché, premier montage).
 */
class MapBlurMirrorScheduler {
  private readonly map: MapboxMap;

  private readonly sourceCanvas: HTMLCanvasElement;

  private readonly mirrors = new Set<MirrorInstance>();

  private readonly sourceObserver: ResizeObserver;

  private readonly snapshot: HTMLCanvasElement;

  private readonly snapshotCtx: CanvasRenderingContext2D | null;

  private snapshotValid = false;

  private geometryRaf = 0;

  private settleTimer = 0;

  private renderSubscribed = false;

  private attached = false;

  private visible = document.visibilityState !== 'hidden';

  private moving = false;

  private forcePending = false;

  private cachedSourceRect: DOMRect | null = null;

  constructor(map: MapboxMap) {
    this.map = map;
    this.sourceCanvas = map.getCanvas() as HTMLCanvasElement;
    this.snapshot = document.createElement('canvas');
    this.snapshotCtx = this.snapshot.getContext('2d', { alpha: true });
    this.sourceObserver = new ResizeObserver(() => {
      this.invalidateSnapshot();
      this.requestRedraw();
    });
  }

  register(mirror: MirrorInstance) {
    this.mirrors.add(mirror);
    mirror.applyPresentation(this.moving);

    if (!this.attached) {
      this.attach();
    }

    this.requestRedraw();
  }

  unregister(mirror: MirrorInstance) {
    this.mirrors.delete(mirror);

    if (this.mirrors.size === 0) {
      this.detach();
      mapBlurMirrorSchedulers.delete(this.map);
    }
  }

  /** La géométrie du miroir a changé : redécoupe depuis l'instantané, ou demande une image de carte s'il n'y en a pas. */
  requestRedraw() {
    this.invalidateSourceRect();
    for (const mirror of this.mirrors) {
      mirror.cachedTargetRect = null;
    }
    if (!this.snapshotValid || this.moving) {
      this.requestForcedCopy();
      this.restartSettleTimer();
      return;
    }
    if (this.geometryRaf !== 0 || !this.visible) return;
    this.geometryRaf = requestAnimationFrame(() => {
      this.geometryRaf = 0;
      this.cutMirrors(true);
    });
  }

  invalidateMirrorRect(mirror: MirrorInstance) {
    mirror.cachedTargetRect = null;
    this.requestRedraw();
  }

  getSourceRect() {
    if (!this.cachedSourceRect) {
      this.cachedSourceRect = this.sourceCanvas.getBoundingClientRect();
    }

    return this.cachedSourceRect;
  }

  private attach() {
    if (this.attached) return;

    this.attached = true;
    this.sourceObserver.observe(this.sourceCanvas);
    this.map.on('movestart', this.handleMoveStart);
    this.map.on('moveend', this.handleMoveEnd);
    window.addEventListener('resize', this.handleWindowResize);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.subscribeRender();
    this.restartSettleTimer();
  }

  private detach() {
    if (!this.attached) return;

    this.attached = false;
    this.sourceObserver.disconnect();
    this.unsubscribeRender();
    this.clearSettleTimer();
    this.cancelGeometryRaf();
    this.map.off('movestart', this.handleMoveStart);
    this.map.off('moveend', this.handleMoveEnd);
    window.removeEventListener('resize', this.handleWindowResize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.cachedSourceRect = null;
    this.moving = false;
    this.forcePending = false;
    this.invalidateSnapshot();
    this.snapshot.width = 0;
    this.snapshot.height = 0;
  }

  private subscribeRender() {
    if (this.renderSubscribed) return;
    this.map.on('render', this.handleMapRender);
    this.renderSubscribed = true;
  }

  private unsubscribeRender() {
    if (!this.renderSubscribed) return;
    this.map.off('render', this.handleMapRender);
    this.renderSubscribed = false;
  }

  private invalidateSourceRect() {
    this.cachedSourceRect = null;
  }

  private invalidateSnapshot() {
    this.invalidateSourceRect();
    this.snapshotValid = false;
  }

  private cancelGeometryRaf() {
    if (this.geometryRaf !== 0) {
      cancelAnimationFrame(this.geometryRaf);
      this.geometryRaf = 0;
    }
  }

  private requestForcedCopy() {
    if (!this.visible || this.mirrors.size === 0) return;
    this.forcePending = true;
    this.clearSettleTimer();
    this.subscribeRender();
    this.map.triggerRepaint();
  }

  private clearSettleTimer() {
    if (this.settleTimer !== 0) {
      clearTimeout(this.settleTimer);
      this.settleTimer = 0;
    }
  }

  private restartSettleTimer() {
    this.clearSettleTimer();
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      if (!this.moving && !this.forcePending) {
        this.unsubscribeRender();
      }
    }, SETTLE_AFTER_MOVE_MS);
  }

  /** Réduit l'image WebGL courante dans l'instantané. Doit s'exécuter dans `render`. */
  private refreshSnapshot(): boolean {
    const src = this.sourceCanvas;
    const ctx = this.snapshotCtx;
    if (!ctx || !src || src.width === 0 || src.height === 0) return false;

    const srcRect = this.getSourceRect();
    if (srcRect.width <= 0 || srcRect.height <= 0) return false;

    const targetW = Math.max(32, Math.round(srcRect.width * MIRROR_SCALE));
    const targetH = Math.max(32, Math.round(srcRect.height * MIRROR_SCALE));
    if (this.snapshot.width !== targetW || this.snapshot.height !== targetH) {
      this.snapshot.width = targetW;
      this.snapshot.height = targetH;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    try {
      ctx.clearRect(0, 0, targetW, targetH);
      ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, targetW, targetH);
      this.snapshotValid = true;
      return true;
    } catch {
      /* drawImage peut lever une exception si le contexte WebGL a été perdu ; on ignore une image */
      return false;
    }
  }

  /** Découpe dans l'instantané chaque miroir à mettre à jour (2D -> 2D, peu coûteux). */
  private cutMirrors(force: boolean, dueOnly?: Set<MirrorInstance>) {
    if (!this.visible || !this.snapshotValid) return;

    const srcRect = this.getSourceRect();
    if (srcRect.width <= 0 || srcRect.height <= 0) return;
    const scaleX = this.snapshot.width / srcRect.width;
    const scaleY = this.snapshot.height / srcRect.height;
    const now = performance.now();

    for (const mirror of this.mirrors) {
      if (dueOnly && !dueOnly.has(mirror)) continue;

      const mirrorRect = mirror.cachedTargetRect ?? (mirror.cachedTargetRect = mirror.canvas.getBoundingClientRect());
      if (mirrorRect.width <= 0 || mirrorRect.height <= 0) continue;

      const sx = Math.max(0, Math.floor((mirrorRect.left - srcRect.left) * scaleX));
      const sy = Math.max(0, Math.floor((mirrorRect.top - srcRect.top) * scaleY));
      const sw = Math.min(this.snapshot.width - sx, Math.ceil(mirrorRect.width * scaleX));
      const sh = Math.min(this.snapshot.height - sy, Math.ceil(mirrorRect.height * scaleY));
      if (sw <= 0 || sh <= 0) continue;

      const targetW = Math.max(32, Math.round(mirrorRect.width * MIRROR_SCALE));
      const targetH = Math.max(32, Math.round(mirrorRect.height * MIRROR_SCALE));
      if (mirror.canvas.width !== targetW || mirror.canvas.height !== targetH) {
        mirror.canvas.width = targetW;
        mirror.canvas.height = targetH;
      }

      mirror.ctx.imageSmoothingEnabled = true;
      mirror.ctx.imageSmoothingQuality = 'medium';
      mirror.ctx.clearRect(0, 0, targetW, targetH);
      mirror.ctx.drawImage(this.snapshot, sx, sy, sw, sh, 0, 0, targetW, targetH);
      if (force || dueOnly) mirror.lastDrawAt = now;
    }
  }

  private readonly handleMapRender = () => {
    const force = this.forcePending;
    this.forcePending = false;
    if (!this.visible || this.mirrors.size === 0) return;

    let due: Set<MirrorInstance> | undefined;
    if (!force) {
      const now = performance.now();
      due = new Set();
      for (const mirror of this.mirrors) {
        const frameBudget = this.moving
          ? mirror.frameProfile.activeFrameMs
          : mirror.frameProfile.idleFrameMs;
        if (now - mirror.lastDrawAt >= frameBudget) due.add(mirror);
      }
      if (due.size === 0) return;
    }

    if (this.refreshSnapshot()) {
      this.cutMirrors(true, due);
    }
    if (force && !this.moving) this.restartSettleTimer();
  };

  private readonly handleMoveStart = () => {
    this.moving = true;
    for (const mirror of this.mirrors) {
      mirror.applyPresentation(true);
      mirror.cachedTargetRect = null;
    }
    this.requestForcedCopy();
  };

  private readonly handleMoveEnd = () => {
    this.moving = false;
    for (const mirror of this.mirrors) {
      mirror.applyPresentation(false);
      mirror.cachedTargetRect = null;
    }
    this.requestForcedCopy();
    this.restartSettleTimer();
  };

  private readonly handleWindowResize = () => {
    this.invalidateSnapshot();
    this.requestRedraw();
  };

  private readonly handleVisibilityChange = () => {
    this.visible = document.visibilityState !== 'hidden';
    if (!this.visible) {
      this.clearSettleTimer();
      this.unsubscribeRender();
      this.cancelGeometryRaf();
      this.forcePending = false;
      return;
    }

    this.invalidateSnapshot();
    this.requestRedraw();
  };
}

function getMapBlurMirrorScheduler(map: MapboxMap) {
  let scheduler = mapBlurMirrorSchedulers.get(map);
  if (!scheduler) {
    scheduler = new MapBlurMirrorScheduler(map);
    mapBlurMirrorSchedulers.set(map, scheduler);
  }

  return scheduler;
}

interface MapBlurMirrorProps {
  /** Instance de carte Mapbox. Les copies sont faites dans `render`, sans besoin de `preserveDrawingBuffer`. */
  map: MapboxMap | null;
  /** Géométrie absolue de la région à refléter. */
  top: number;
  left: number;
  width: number;
  height: number;
  zIndex?: number;
  blur?: number;
  saturate?: number;
  borderRadius?: number;
}

export default function MapBlurMirror({
  map,
  top,
  left,
  width,
  height,
  zIndex = 24,
  blur = 24,
  saturate = 1.4,
  borderRadius,
}: MapBlurMirrorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const movingRef = useRef(false);
  const requestRedrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    });
    if (!ctx) return;

    const scheduler = getMapBlurMirrorScheduler(map);
    const EFFECTIVE_BLUR = Math.max(16, blur);
    const ACTIVE_BLUR = Math.max(12, Math.round(blur * 0.75));
    const ACTIVE_SATURATE = Math.max(1, Number((saturate * 0.95).toFixed(2)));
    const frameProfile = getMirrorFrameProfile();

    const applyPresentation = (moving: boolean) => {
      movingRef.current = moving;
      canvas.style.filter = moving
        ? `blur(${ACTIVE_BLUR}px) saturate(${ACTIVE_SATURATE}) brightness(0.96)`
        : `blur(${EFFECTIVE_BLUR}px) saturate(${saturate}) brightness(0.96)`;
      canvas.style.opacity = moving ? '0.96' : '1';
    };

    const mirror: MirrorInstance = {
      canvas,
      ctx,
      activeBlur: ACTIVE_BLUR,
      activeSaturate: ACTIVE_SATURATE,
      blur,
      saturate,
      frameProfile,
      cachedTargetRect: null,
      lastDrawAt: 0,
      applyPresentation,
    };

    requestRedrawRef.current = () => {
      scheduler.invalidateMirrorRect(mirror);
    };

    const targetObserver = new ResizeObserver(() => {
      scheduler.invalidateMirrorRect(mirror);
    });
    targetObserver.observe(canvas);

    scheduler.register(mirror);

    return () => {
      requestRedrawRef.current = null;
      targetObserver.disconnect();
      scheduler.unregister(mirror);
    };
  }, [blur, map, saturate]);

  useLayoutEffect(() => {
    requestRedrawRef.current?.();
  }, [height, left, top, width]);

  const initialBlur = Math.max(16, blur);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'absolute',
        top,
        left,
        width,
        height,
        zIndex,
        pointerEvents: 'none',
        filter: `blur(${initialBlur}px) saturate(${saturate}) brightness(0.96)`,
        transform: 'scale(1.08)',
        transformOrigin: 'center',
        borderRadius,
        overflow: 'hidden',
        willChange: 'transform',
      }}
    />
  );
}
