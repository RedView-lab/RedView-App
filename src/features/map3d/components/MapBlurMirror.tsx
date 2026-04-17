import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let dirty = true;

    const draw = () => {
      raf = 0;
      const src = map.getCanvas() as HTMLCanvasElement;
      if (!src || src.width === 0 || src.height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      // Source-canvas pixels per CSS pixel (Mapbox internally uses DPR too).
      const srcCanvasRect = src.getBoundingClientRect();
      const sxScale = src.width / Math.max(srcCanvasRect.width, 1);
      const syScale = src.height / Math.max(srcCanvasRect.height, 1);

      // Where this mirror sits relative to the map canvas, in CSS px.
      const mirrorRect = canvas.getBoundingClientRect();
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
      const targetW = Math.max(1, Math.round(mirrorRect.width * dpr));
      const targetH = Math.max(1, Math.round(mirrorRect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (sw > 0 && sh > 0) {
        try {
          ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        } catch {
          /* drawImage can throw if the WebGL context was lost; ignore one frame */
        }
      }
    };

    const schedule = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(draw);
    };

    const onMapRender = () => {
      dirty = true;
      schedule();
    };

    // Initial paint + keep redrawing while the map renders.
    map.on('render', onMapRender);
    schedule();

    // Also redraw when the window resizes (panel rect may move).
    const onResize = () => {
      dirty = true;
      schedule();
    };
    window.addEventListener('resize', onResize);

    // Mute the unused-warning for `dirty` (kept for future throttling).
    void dirty;

    return () => {
      map.off('render', onMapRender);
      window.removeEventListener('resize', onResize);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [map]);

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
