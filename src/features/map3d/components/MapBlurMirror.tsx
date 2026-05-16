import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;

    const sourceCanvas = map.getCanvas() as HTMLCanvasElement;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    });
    if (!ctx) return;

    const ACTIVE_FRAME_MS = 1000 / 30;
    const IDLE_FRAME_MS = 1000 / 12;
    // After moveend we let a few "settling" frames render (terrain/ortho fade
    // in, fog updates, last tile pops), then we STOP subscribing to render.
    // Mapbox keeps firing `render` while terrain/fog/ortho refresh in the
    // background even when the camera is fully still — without this gate
    // every background tile load would re-trigger a full canvas blit + the
    // expensive blur(30px) compositor pass on every mounted mirror (up to 4
    // simultaneously). After the settle window we simply trust the last
    // frame; on the next user gesture (movestart) we re-engage.
    const SETTLE_AFTER_MOVE_MS = 700;

    let raf = 0;
    let timer = 0;
    let settleTimer = 0;
    let lastDrawAt = 0;
    let renderSubscribed = false;
    let isVisible = document.visibilityState !== 'hidden';
    let cachedTargetRect: DOMRect | null = null;
    let cachedSourceRect: DOMRect | null = null;
    const ACTIVE_BLUR = Math.max(10, Math.round(blur * 0.55));
    const ACTIVE_SATURATE = Math.max(1, Number((saturate * 0.72).toFixed(2)));

    const applyPresentation = () => {
      canvas.style.filter = movingRef.current
        ? `blur(${ACTIVE_BLUR}px) saturate(${ACTIVE_SATURATE})`
        : `blur(${blur}px) saturate(${saturate})`;
      canvas.style.opacity = movingRef.current ? '0.94' : '1';
    };

    applyPresentation();

    const clearScheduledDraw = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (timer !== 0) {
        clearTimeout(timer);
        timer = 0;
      }
    };

    const invalidateRects = () => {
      cachedTargetRect = null;
      cachedSourceRect = null;
    };

    const getRenderDpr = (rect: DOMRect) => {
      const baseDpr = window.devicePixelRatio || 1;
      const area = rect.width * rect.height;
      if (area >= 240000) return Math.min(baseDpr, 1);
      return Math.min(baseDpr, 1.25);
    };

    const draw = () => {
      raf = 0;
      timer = 0;
      if (!isVisible) return;

      const src = sourceCanvas;
      if (!src || src.width === 0 || src.height === 0) return;

      lastDrawAt = performance.now();

      // Source-canvas pixels per CSS pixel (Mapbox internally uses DPR too).
      const srcCanvasRect = cachedSourceRect ?? (cachedSourceRect = src.getBoundingClientRect());
      const sxScale = src.width / Math.max(srcCanvasRect.width, 1);
      const syScale = src.height / Math.max(srcCanvasRect.height, 1);

      // Where this mirror sits relative to the map canvas, in CSS px.
      const mirrorRect = cachedTargetRect ?? (cachedTargetRect = canvas.getBoundingClientRect());
      const offsetX = mirrorRect.left - srcCanvasRect.left;
      const offsetY = mirrorRect.top - srcCanvasRect.top;

      // Slice of the source canvas (in source-canvas device pixels) that
      // covers this mirror's CSS rectangle.
      const sx = Math.max(0, Math.floor(offsetX * sxScale));
      const sy = Math.max(0, Math.floor(offsetY * syScale));
      const sw = Math.min(
        src.width - sx,
        Math.ceil(mirrorRect.width * sxScale),
      );
      const sh = Math.min(
        src.height - sy,
        Math.ceil(mirrorRect.height * syScale),
      );

      // Match the mirror canvas's backing-store size to its CSS rect × DPR.
      const dpr = getRenderDpr(mirrorRect);
      const targetW = Math.max(1, Math.round(mirrorRect.width * dpr));
      const targetH = Math.max(1, Math.round(mirrorRect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      if (sw > 0 && sh > 0) {
        try {
          ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } catch {
          /* drawImage can throw if the WebGL context was lost; ignore one frame */
        }
      }
    };

    const schedule = (force = false) => {
      if (!isVisible) return;

      const frameBudget = movingRef.current ? ACTIVE_FRAME_MS : IDLE_FRAME_MS;
      const elapsed = performance.now() - lastDrawAt;

      if (!force && (raf !== 0 || timer !== 0)) return;

      if (!force && elapsed < frameBudget) {
        timer = window.setTimeout(() => {
          timer = 0;
          if (raf === 0) raf = requestAnimationFrame(draw);
        }, Math.max(0, Math.ceil(frameBudget - elapsed)));
        return;
      }

      if (timer !== 0) {
        clearTimeout(timer);
        timer = 0;
      }
      if (raf !== 0) {
        if (!force) return;
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(draw);
    };

    requestRedrawRef.current = () => {
      invalidateRects();
      // External geometry change (panel resize, window resize, layout shift):
      // re-engage the render listener for one settle window so we catch any
      // tile/fog updates that land while the rect is in motion.
      clearSettleTimer();
      subscribeRender();
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        unsubscribeRender();
      }, SETTLE_AFTER_MOVE_MS);
      schedule(true);
    };

    const onMapRender = () => {
      schedule();
    };

    const subscribeRender = () => {
      if (renderSubscribed) return;
      map.on('render', onMapRender);
      renderSubscribed = true;
    };

    const unsubscribeRender = () => {
      if (!renderSubscribed) return;
      map.off('render', onMapRender);
      renderSubscribed = false;
    };

    const clearSettleTimer = () => {
      if (settleTimer !== 0) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
    };

    const onMoveStart = () => {
      movingRef.current = true;
      applyPresentation();
      cachedTargetRect = null;
      clearSettleTimer();
      subscribeRender();
      schedule(true);
    };

    const onMoveEnd = () => {
      movingRef.current = false;
      applyPresentation();
      cachedTargetRect = null;
      schedule(true);
      // Let the map settle (terrain/ortho/fog finish their last paints),
      // then unsubscribe from render to stop burning CPU on background
      // tile loads while the user isn't touching the camera.
      clearSettleTimer();
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        unsubscribeRender();
      }, SETTLE_AFTER_MOVE_MS);
    };

    const onVisibility = () => {
      isVisible = document.visibilityState !== 'hidden';
      if (!isVisible) {
        clearSettleTimer();
        unsubscribeRender();
        clearScheduledDraw();
        return;
      }
      requestRedrawRef.current?.();
    };

    const targetObserver = new ResizeObserver(() => {
      requestRedrawRef.current?.();
    });
    targetObserver.observe(canvas);

    const sourceObserver = new ResizeObserver(() => {
      requestRedrawRef.current?.();
    });
    sourceObserver.observe(sourceCanvas);

    // Initial paint + keep redrawing while the camera moves. Render
    // subscription auto-disengages SETTLE_AFTER_MOVE_MS after each moveend
    // (see onMoveEnd) so we don't blit on every background tile load.
    subscribeRender();
    map.on('movestart', onMoveStart);
    map.on('moveend', onMoveEnd);
    schedule(true);
    // Auto-settle the very first paint so we don't keep blitting forever
    // if the user never moves the camera (carte libre idle case).
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      unsubscribeRender();
    }, SETTLE_AFTER_MOVE_MS);

    // Also redraw when the window resizes (panel rect may move).
    const onResize = () => {
      requestRedrawRef.current?.();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      requestRedrawRef.current = null;
      unsubscribeRender();
      map.off('movestart', onMoveStart);
      map.off('moveend', onMoveEnd);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      targetObserver.disconnect();
      sourceObserver.disconnect();
      clearSettleTimer();
      clearScheduledDraw();
    };
  }, [blur, map, saturate]);

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
