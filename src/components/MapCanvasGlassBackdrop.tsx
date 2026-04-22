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

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);

      const source = document.querySelector<HTMLCanvasElement>(MAPBOX_CANVAS_SELECTOR);
      if (!source || source.width === 0 || source.height === 0) return;

      const sourceRect = source.getBoundingClientRect();
      const targetRect = canvas.getBoundingClientRect();
      if (sourceRect.width <= 0 || sourceRect.height <= 0 || targetRect.width <= 0 || targetRect.height <= 0) {
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(1, Math.round(targetRect.width * dpr));
      const targetHeight = Math.max(1, Math.round(targetRect.height * dpr));
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

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (sw <= 0 || sh <= 0) return;

      try {
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      } catch {
        // Ignore transient WebGL context / drawImage failures for a frame.
      }
    };

    draw();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
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