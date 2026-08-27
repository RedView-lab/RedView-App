import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

const SETTLE_AFTER_MOVE_MS = 250;
const MIRROR_SCALE = 0.5; // 50% resolution (e.g. 190x450px) = crisp details with zero pixelation on AMD Ryzen

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
  // 14 FPS during camera movement is completely fluid for a heavily blurred background
  // while saving over 80% of GPU copy cycles on integrated AMD Radeon GPUs.
  const activeFps = 14;

  return {
    activeFrameMs: 1000 / activeFps,
    idleFrameMs: Number.POSITIVE_INFINITY,
  };
}

class MapBlurMirrorScheduler {
  private readonly map: MapboxMap;

  private readonly sourceCanvas: HTMLCanvasElement;

  private readonly mirrors = new Set<MirrorInstance>();

  private readonly sourceObserver: ResizeObserver;

  private raf = 0;

  private timer = 0;

  private settleTimer = 0;

  private renderSubscribed = false;

  private attached = false;

  private visible = document.visibilityState !== 'hidden';

  private moving = false;

  private cachedSourceRect: DOMRect | null = null;

  constructor(map: MapboxMap) {
    this.map = map;
    this.sourceCanvas = map.getCanvas() as HTMLCanvasElement;
    this.sourceObserver = new ResizeObserver(() => {
      this.invalidateSourceRect();
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

  requestRedraw() {
    this.invalidateSourceRect();
    for (const mirror of this.mirrors) {
      mirror.cachedTargetRect = null;
    }

    this.clearSettleTimer();
    this.subscribeRender();
    this.schedule(true);
    this.restartSettleTimer();
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
    this.clearScheduledDraw();
    this.clearSettleTimer();
    this.map.off('movestart', this.handleMoveStart);
    this.map.off('moveend', this.handleMoveEnd);
    window.removeEventListener('resize', this.handleWindowResize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.cachedSourceRect = null;
    this.moving = false;
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

  private clearScheduledDraw() {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.timer !== 0) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
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
      if (!this.moving) {
        this.unsubscribeRender();
      }
    }, SETTLE_AFTER_MOVE_MS);
  }

  private schedule(force = false) {
    if (!this.visible || this.mirrors.size === 0) return;

    const now = performance.now();

    if (force) {
      if (this.timer !== 0) {
        clearTimeout(this.timer);
        this.timer = 0;
      }
      if (this.raf !== 0) {
        cancelAnimationFrame(this.raf);
      }
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.flush(true);
      });
      return;
    }

    if (this.raf !== 0 || this.timer !== 0) return;

    const nextDelay = this.getNextDelay(now);
    if (!Number.isFinite(nextDelay)) return; // Idle: do not schedule background poll

    if (nextDelay <= 0) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.flush(false);
      });
      return;
    }

    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (this.raf === 0) {
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          this.flush(false);
        });
      }
    }, Math.max(1, Math.ceil(nextDelay)));
  }

  private getNextDelay(now: number) {
    let nextDelay = Number.POSITIVE_INFINITY;

    for (const mirror of this.mirrors) {
      const frameBudget = this.moving
        ? mirror.frameProfile.activeFrameMs
        : mirror.frameProfile.idleFrameMs;
      const elapsed = now - mirror.lastDrawAt;
      nextDelay = Math.min(nextDelay, Math.max(0, frameBudget - elapsed));
    }

    return nextDelay;
  }

  private flush(force: boolean) {
    if (!this.visible || this.mirrors.size === 0) return;

    const src = this.sourceCanvas;
    if (!src || src.width === 0 || src.height === 0) return;

    const srcCanvasRect = this.getSourceRect();
    if (srcCanvasRect.width <= 0 || srcCanvasRect.height <= 0) return;

    const now = performance.now();
    const sxScale = src.width / Math.max(srcCanvasRect.width, 1);
    const syScale = src.height / Math.max(srcCanvasRect.height, 1);

    for (const mirror of this.mirrors) {
      const frameBudget = this.moving
        ? mirror.frameProfile.activeFrameMs
        : mirror.frameProfile.idleFrameMs;
      const elapsed = now - mirror.lastDrawAt;
      if (!force && elapsed < frameBudget) {
        continue;
      }

      const mirrorRect = mirror.cachedTargetRect ?? (mirror.cachedTargetRect = mirror.canvas.getBoundingClientRect());
      if (mirrorRect.width <= 0 || mirrorRect.height <= 0) {
        continue;
      }

      const offsetX = mirrorRect.left - srcCanvasRect.left;
      const offsetY = mirrorRect.top - srcCanvasRect.top;
      const sx = Math.max(0, Math.floor(offsetX * sxScale));
      const sy = Math.max(0, Math.floor(offsetY * syScale));
      const sw = Math.min(src.width - sx, Math.ceil(mirrorRect.width * sxScale));
      const sh = Math.min(src.height - sy, Math.ceil(mirrorRect.height * syScale));
      if (sw <= 0 || sh <= 0) {
        continue;
      }

      // High-quality downscaled buffer with bicubic/bilinear smoothing
      const targetW = Math.max(32, Math.round(mirrorRect.width * MIRROR_SCALE));
      const targetH = Math.max(32, Math.round(mirrorRect.height * MIRROR_SCALE));
      if (mirror.canvas.width !== targetW || mirror.canvas.height !== targetH) {
        mirror.canvas.width = targetW;
        mirror.canvas.height = targetH;
      }

      mirror.ctx.clearRect(0, 0, mirror.canvas.width, mirror.canvas.height);
      mirror.ctx.imageSmoothingEnabled = true;
      mirror.ctx.imageSmoothingQuality = 'high';
      try {
        mirror.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, mirror.canvas.width, mirror.canvas.height);
        mirror.lastDrawAt = now;
      } catch {
        /* drawImage can throw if the WebGL context was lost; ignore one frame */
      }
    }

    this.schedule(false);
  }

  private readonly handleMapRender = () => {
    this.schedule(false);
  };

  private readonly handleMoveStart = () => {
    this.moving = true;
    for (const mirror of this.mirrors) {
      mirror.applyPresentation(true);
      mirror.cachedTargetRect = null;
    }
    this.clearSettleTimer();
    this.subscribeRender();
    this.schedule(true);
  };

  private readonly handleMoveEnd = () => {
    this.moving = false;
    for (const mirror of this.mirrors) {
      mirror.applyPresentation(false);
      mirror.cachedTargetRect = null;
    }
    this.schedule(true);
    this.restartSettleTimer();
  };

  private readonly handleWindowResize = () => {
    this.requestRedraw();
  };

  private readonly handleVisibilityChange = () => {
    this.visible = document.visibilityState !== 'hidden';
    if (!this.visible) {
      this.clearSettleTimer();
      this.unsubscribeRender();
      this.clearScheduledDraw();
      return;
    }

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
  /** Mapbox map instance (created with `preserveDrawingBuffer: true`). */
  map: MapboxMap | null;
  /** Absolute geometry of the region to mirror. */
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
  const mirrorArea = width * height;

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
  }, [blur, map, mirrorArea, saturate]);

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
