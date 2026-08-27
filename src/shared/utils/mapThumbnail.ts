/**
 * Capture a downsized JPEG snapshot of the live Mapbox canvas.
 *
 * Used by the project browser to show a per-project thumbnail.
 * Requires the Map to have been instantiated with
 * `preserveDrawingBuffer: true` (already the case in `useMap.ts`).
 *
 * The capture pipeline is:
 *   map canvas (full device-pixel resolution)
 *     → offscreen canvas at `targetWidth` (object-fit: cover)
 *     → JPEG blob
 *
 * Returns null if the map isn't ready or the capture failed for any
 * reason (read-back blocked, taint, OOM…). Callers should treat null
 * as "skip thumbnail upload, keep the previous one".
 */
import type { Map as MapboxMap } from 'mapbox-gl';

export async function captureMapThumbnail(
  map: MapboxMap | null,
  targetWidth = 360,
  aspectRatio = 16 / 9,
): Promise<Blob | null> {
  if (!map) return null;

  const renderSnapshot = (src: HTMLCanvasElement): Promise<Blob | null> => {
    try {
      const targetHeight = Math.round(targetWidth / aspectRatio);
      const off = document.createElement('canvas');
      off.width = targetWidth;
      off.height = targetHeight;
      const ctx = off.getContext('2d');
      if (!ctx) return Promise.resolve(null);
      ctx.fillStyle = '#141414';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Cover: scale to fill, crop excess.
      const srcAspect = src.width / src.height;
      let sx = 0;
      let sy = 0;
      let sw = src.width;
      let sh = src.height;
      if (srcAspect > aspectRatio) {
        sw = Math.round(src.height * aspectRatio);
        sx = Math.round((src.width - sw) / 2);
      } else {
        sh = Math.round(src.width / aspectRatio);
        sy = Math.round((src.height - sh) / 2);
      }
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

      return new Promise<Blob | null>((resolve) => {
        off.toBlob((b) => resolve(b), 'image/jpeg', 0.72);
      });
    } catch {
      return Promise.resolve(null);
    }
  };

  return new Promise<Blob | null>((resolve) => {
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      resolve(blob);
    };

    // Grab canvas immediately in the render callback before the buffer is cleared
    const onRender = () => {
      try {
        const src = map.getCanvas();
        if (!src || src.width === 0 || src.height === 0) {
          finish(null);
          return;
        }
        void renderSnapshot(src).then(finish);
      } catch {
        finish(null);
      }
    };

    map.once('render', onRender);
    map.triggerRepaint();

    // Fallback: direct attempt or timeout in case map is already painted or unmounted
    setTimeout(() => {
      if (settled) return;
      const src = map.getCanvas?.();
      if (src && src.width > 0 && src.height > 0) {
        void renderSnapshot(src).then(finish);
      } else {
        finish(null);
      }
    }, 600);
  });
}
