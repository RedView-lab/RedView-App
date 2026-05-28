import { useEffect, useRef } from 'react';

interface MapCanvasGlassBackdropProps {
  blur?: number;
  saturate?: number;
  tint?: string;
}

const MAPBOX_CANVAS_SELECTOR = '.mapboxgl-canvas';

export function MapCanvasGlassBackdrop({
  blur = 30,
  saturate = 1.8,
  tint = 'rgba(15, 15, 15, 0.74)',
}: MapCanvasGlassBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    });
    if (!ctx) return;

    // Behind a 30px blur the human eye cannot detect updates faster than ~10-12 FPS.
    // Polling instead of running a full-rate RAF loop saves ~50% main-thread + GPU
    // copy budget when dropdowns / popovers using this backdrop are open.
    const TARGET_FPS = 12;
    const FRAME_MS = 1000 / TARGET_FPS;
    // Cap effective DPR at 1: blur(30px) destroys sub-pixel detail anyway.
    const RENDER_DPR = Math.min(1, window.devicePixelRatio || 1);

    let timer = 0;
    let isDocumentVisible = document.visibilityState !== 'hidden';
    let isIntersecting = true;
    let cachedTargetRect: DOMRect | null = null;
    let cachedSourceRect: DOMRect | null = null;
    let sourceCanvas: HTMLCanvasElement | null = null;

    const clearTimer = () => {
      if (timer !== 0) {
        clearTimeout(timer);
        timer = 0;
      }
    };

    const invalidateTargetRect = () => {
      cachedTargetRect = null;
    };

    const invalidateSourceRect = () => {
      cachedSourceRect = null;
    };

    const resolveSourceCanvas = () => {
      if (sourceCanvas?.isConnected) return sourceCanvas;

      sourceCanvas = document.querySelector<HTMLCanvasElement>(MAPBOX_CANVAS_SELECTOR);
      cachedSourceRect = null;
      return sourceCanvas;
    };

    const shouldPoll = () => isDocumentVisible && isIntersecting;

    const schedule = () => {
      if (!shouldPoll() || timer !== 0) return;

      timer = window.setTimeout(() => {
        timer = 0;
        draw();
        schedule();
      }, FRAME_MS);
    };

    const onVisibility = () => {
      isDocumentVisible = document.visibilityState !== 'hidden';
      if (!shouldPoll()) {
        clearTimer();
        return;
      }

      draw();
      schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Cache target rect; refresh only on resize instead of per-frame.
    const ro = new ResizeObserver(() => {
      invalidateTargetRect();
    });
    ro.observe(canvas);

    const sourceResizeObserver = new ResizeObserver(() => {
      invalidateSourceRect();
    });

    const intersectionObserver = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
          isIntersecting = entries.some((entry) => entry.isIntersecting);
          if (!shouldPoll()) {
            clearTimer();
            return;
          }

          draw();
          schedule();
        })
      : null;
    intersectionObserver?.observe(canvas);

    const onResize = () => {
      invalidateTargetRect();
      invalidateSourceRect();
      if (!shouldPoll()) return;
      draw();
      schedule();
    };
    window.addEventListener('resize', onResize);

    const draw = () => {
      if (!shouldPoll()) return;

      const source = resolveSourceCanvas();
      if (!source || source.width === 0 || source.height === 0) return;

      if (sourceCanvas !== source) {
        sourceResizeObserver.disconnect();
        sourceResizeObserver.observe(source);
        invalidateSourceRect();
      }

      const targetRect = cachedTargetRect ?? (cachedTargetRect = canvas.getBoundingClientRect());
      if (targetRect.width <= 0 || targetRect.height <= 0) return;

      const sourceRect = cachedSourceRect ?? (cachedSourceRect = source.getBoundingClientRect());
      if (sourceRect.width <= 0 || sourceRect.height <= 0) return;

      const targetWidth = Math.max(1, Math.round(targetRect.width * RENDER_DPR));
      const targetHeight = Math.max(1, Math.round(targetRect.height * RENDER_DPR));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const sxScale = source.width / Math.max(sourceRect.width, 1);
      const syScale = source.height / Math.max(sourceRect.height, 1);
      const offsetX = targetRect.left - sourceRect.left;
      const offsetY = targetRect.top - sourceRect.top;
      const sx = Math.max(0, Math.floor(offsetX * sxScale));
      const sy = Math.max(0, Math.floor(offsetY * syScale));
      const sw = Math.min(source.width - sx, Math.ceil(targetRect.width * sxScale));
      const sh = Math.min(source.height - sy, Math.ceil(targetRect.height * syScale));

      if (sw <= 0 || sh <= 0) return;

      try {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      } catch {
        // Ignore transient WebGL context / drawImage failures for a frame.
      }
    };

    draw();
    schedule();

    return () => {
      clearTimer();
      ro.disconnect();
      sourceResizeObserver.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          filter: `blur(${blur}px) saturate(${saturate})`,
          transform: 'scale(1.08)',
          transformOrigin: 'center',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: tint,
        }}
      />
    </div>
  );
}