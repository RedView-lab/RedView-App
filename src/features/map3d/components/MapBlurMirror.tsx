import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

const SETTLE_AFTER_MOVE_MS = 700;

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

function getMirrorFrameProfile(area: number): MirrorFrameProfile {
  const activeFps = area >= 220000 ? 20 : area >= 120000 ? 24 : 30;
  const idleFps = area >= 220000 ? 10 : 12;

  return {
    activeFrameMs: 1000 / activeFps,
    idleFrameMs: 1000 / idleFps,
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

    return Number.isFinite(nextDelay) ? nextDelay : 0;
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

      const dpr = getRenderDpr(mirrorRect);
      const targetW = Math.max(1, Math.round(mirrorRect.width * dpr));
      const targetH = Math.max(1, Math.round(mirrorRect.height * dpr));
      if (mirror.canvas.width !== targetW || mirror.canvas.height !== targetH) {
        mirror.canvas.width = targetW;
        mirror.canvas.height = targetH;
      }

      mirror.ctx.clearRect(0, 0, mirror.canvas.width, mirror.canvas.height);
      mirror.ctx.imageSmoothingEnabled = true;
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

function getRenderDpr(rect: DOMRect) {
  const baseDpr = window.devicePixelRatio || 1;
  const area = rect.width * rect.height;
  if (area >= 240000) return Math.min(baseDpr, 1);
  return Math.min(baseDpr, 1.25);
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
  /** Mapbox map instance (must have been created with `preserveDrawingBuffer: true`). */
  map: MapboxMap | null;
  /**
   * Absolute geometry of the region to mirror, in CSS pixels relative to the
   * map canvas's offset parent (the same ancestor the overlay panels are
   * positioned against). The mirror canvas is rendered with `position:
   * absolute` and these box values, then it copies the matching slice of the
   * Mapbox WebGL canvas every frame.
   */
  top: number;
  left: number;
  width: number;
  height: number;
  /** Stacking order. Should sit above the map but below the actual panel. */
  zIndex?: number;
  /** Blur radius in CSS pixels. */
  blur?: number;
  /** Saturate amount (CSS filter). */
  saturate?: number;
  /** Optional border-radius to match the panel that will sit on top. */
  borderRadius?: number;
}

/**
 * Renders an HTML 2D canvas that mirrors a slice of the Mapbox WebGL canvas
 * every frame, with a CSS `filter: blur()` applied. This is a workaround for
 * the fact that CSS `backdrop-filter` does not reliably sample a sibling
 * WebGL canvas on Chromium / Safari (the compositor layer boundaries break
 * backdrop sampling, and the WebGL back-buffer is typically discarded before
 * the compositor can read it).
 *
 * Usage: place one of these UNDER each glass panel, with the same `top`,
 * `left`, `width`, `height` as the panel. The panel's `background` should be
 * a translucent tint only (no `backdrop-filter` needed).
 *
 * The mirror redraws on Mapbox's `render` event, so it is in sync with the
 * map without burning CPU when the camera is idle.
 */
export default function MapBlurMirror({
  map,
  top,
  left,
  width,
  height,
  zIndex = 24,
  blur = 30,
  saturate = 1.8,
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
    const ACTIVE_BLUR = Math.max(10, Math.round(blur * 0.55));
    const ACTIVE_SATURATE = Math.max(1, Number((saturate * 0.72).toFixed(2)));
    const frameProfile = getMirrorFrameProfile(mirrorArea);

    const applyPresentation = (moving: boolean) => {
      movingRef.current = moving;
      canvas.style.filter = moving
        ? `blur(${ACTIVE_BLUR}px) saturate(${ACTIVE_SATURATE})`
        : `blur(${blur}px) saturate(${saturate})`;
      canvas.style.opacity = moving ? '0.94' : '1';
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
        filter: `blur(${blur}px) saturate(${saturate})`,
        // Inset the visible blur slightly so the soft edges of the blur do
        // not bleed past the panel rect.
        borderRadius,
        // Performance: tell the compositor this layer changes often.
        willChange: 'transform',
      }}
    />
  );
}
