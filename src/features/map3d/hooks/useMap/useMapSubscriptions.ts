import type { RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { saveViewport, type MapViewport } from '../../lib/viewport-persist';
import {
  getActiveDem3dQuality,
  subscribeDem3dQuality,
} from '../../lib/dem3dQualityBus';
import {
  getActiveDemProfilePreference,
  subscribeDemProfilePreference,
} from '../../lib/demProfileBus';
import type { MapLifecycleController } from './controller/context';

interface SetupMapSubscriptionsArgs {
  map: MapboxMap;
  containerRef: RefObject<HTMLDivElement | null>;
  lifecycle: MapLifecycleController;
  onViewportChangeRef: RefObject<((viewport: MapViewport) => void) | undefined>;
}

/**
 * Configure les écouteurs d'événements, redimensionnements, bus de qualité 3D/DEM
 * et la persistance du viewport sur la carte.
 */
export function setupMapSubscriptions({
  map,
  containerRef,
  lifecycle,
  onViewportChangeRef,
}: SetupMapSubscriptionsArgs) {
  let resizeFrame: number | null = null;
  const scheduleResize = () => {
    if (resizeFrame != null) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null;
      map.resize();
    });
  };

  scheduleResize();

  const resizeObserver = typeof ResizeObserver === 'function' && containerRef.current
    ? new ResizeObserver(() => {
        scheduleResize();
      })
    : null;
  if (containerRef.current) {
    resizeObserver?.observe(containerRef.current);
  }

  if (getActiveDem3dQuality() === 'fast-30m') {
    try { lifecycle.setDem3dQuality('fast-30m'); } catch { /* best-effort */ }
  }
  const unsubscribeDem3dQuality = subscribeDem3dQuality((q) => {
    try { lifecycle.setDem3dQuality(q); } catch (err) {
      console.warn('[map3d] setDem3dQuality failed', err);
    }
  });

  const unsubscribeDemProfile = subscribeDemProfilePreference(() => {
    try {
      lifecycle.reloadMapElevationForProfile();
    } catch (err) {
      console.warn('[map3d] reloadMapElevationForProfile after DEM profile change failed', err);
    }
  });

  if (getActiveDemProfilePreference() !== 'default') {
    try {
      lifecycle.reloadMapElevationForProfile();
    } catch {
      /* best-effort */
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistViewport = (viewport: MapViewport) => {
    saveViewport(viewport);
    onViewportChangeRef.current?.(viewport);
  };

  const onMoveEnd = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const center = map.getCenter();
      persistViewport({
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      });
    }, 500);
  };
  map.on('moveend', onMoveEnd);

  let lastSvgWarnAt = 0;
  let suppressedSvgErrors = 0;
  const onError = (event: { error?: Error }) => {
    const message = event.error?.message || String(event);
    if (message.includes('SVGs are not supported')) {
      const now = Date.now();
      if (now - lastSvgWarnAt < 5000) {
        suppressedSvgErrors += 1;
        return;
      }
      const skipped = suppressedSvgErrors;
      suppressedSvgErrors = 0;
      lastSvgWarnAt = now;
      console.warn(
        '[mapbox] image rejected (SVG not supported by Mapbox 3.x); further occurrences suppressed for 5s',
        skipped > 0 ? `(${skipped} suppressed)` : '',
      );
      return;
    }
    if (message.includes("no source with ID 'mapbox-dem'")) {
      return;
    }
    console.error('[mapbox]', message);
  };
  map.on('error', onError);

  return {
    cleanup: () => {
      resizeObserver?.disconnect();
      if (resizeFrame != null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      unsubscribeDem3dQuality();
      unsubscribeDemProfile();
      if (saveTimer) clearTimeout(saveTimer);
      map.off('moveend', onMoveEnd);
      map.off('error', onError);
    },
    persistCurrentViewport: () => {
      const center = map.getCenter();
      persistViewport({
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      });
    },
  };
}
