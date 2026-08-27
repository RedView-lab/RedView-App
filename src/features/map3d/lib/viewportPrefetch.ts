import type { Map as MapboxMap } from 'mapbox-gl';
import {
  lngLatToTile,
  screenToLngLat,
  PREFETCH_MIN_ZOOM,
  PREFETCH_MAX_ZOOM,
  PREFETCH_MAX_PER_CYCLE,
  PREFETCH_THROTTLE_MS,
  PREFETCH_POST_IDLE_DELAY_MS,
  PITCH_FOREGROUND_THRESHOLD_DEG,
  TELEPORT_TILE_DELTA,
  PREDICTIVE_LEAD_TILES,
  type PriorityHintInit,
} from './prefetch/prefetchGeometry';
import { buildPrefetchUrls, slopePrefetchUrl } from './prefetch/prefetchUrls';
import type {
  ViewportPrefetchOptions,
  PrewarmDestinationOptions,
  ViewportPrefetchHandle,
} from './prefetch/types';

export * from './prefetch/types';

let currentHandle: ViewportPrefetchHandle | null = null;

export function getViewportPrefetch(): ViewportPrefetchHandle | null {
  return currentHandle;
}

/**
 * Installe le moteur de préchargement spéculatif de tuiles basé sur le viewport et les mouvements caméra.
 */
export function installViewportPrefetch(
  map: MapboxMap,
  opts: ViewportPrefetchOptions = {},
): ViewportPrefetchHandle {
  let lastSignature = '';
  let lastFiredAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  let activeAbort: AbortController | null = null;
  let prewarmAbort: AbortController | null = null;
  let lastCentreTile: { x: number; y: number; z: number } | null = null;
  let lastVelocityTile: { dx: number; dy: number } | null = null;

  const dispatchBatch = (
    urls: readonly string[],
    priority: 'low' | 'high',
  ): AbortController | null => {
    if (urls.length === 0) return null;
    const controller = new AbortController();
    const init: PriorityHintInit = {
      priority,
      cache: 'force-cache',
      signal: controller.signal,
    };
    const cap = Math.min(urls.length, PREFETCH_MAX_PER_CYCLE);
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < cap; i++) {
      try {
        promises.push(fetch(urls[i], init).catch(() => undefined));
      } catch {
        /* fetch unavailable */
      }
    }
    void Promise.allSettled(promises);
    return controller;
  };

  const fire = (): void => {
    scheduled = null;
    if (disposed) return;
    if (typeof map.getStyle !== 'function' || !map.getStyle()) return;

    const z = Math.round(map.getZoom());
    if (z < PREFETCH_MIN_ZOOM || z > PREFETCH_MAX_ZOOM) return;

    const bounds = map.getBounds();
    if (!bounds) return;

    const sw = lngLatToTile(bounds.getWest(), bounds.getSouth(), z);
    const ne = lngLatToTile(bounds.getEast(), bounds.getNorth(), z);
    const xMin = Math.min(sw.x, ne.x);
    const xMax = Math.max(sw.x, ne.x);
    const yMin = Math.min(sw.y, ne.y);
    const yMax = Math.max(sw.y, ne.y);

    if (xMax - xMin > 16 || yMax - yMin > 16) return;

    const pitch = typeof map.getPitch === 'function' ? map.getPitch() : 0;
    const tilted = pitch >= PITCH_FOREGROUND_THRESHOLD_DEG;

    let anchor: { lng: number; lat: number } | null = null;
    if (tilted && typeof map.getCanvas === 'function') {
      const canvas = map.getCanvas();
      const w = canvas.clientWidth || canvas.width || 0;
      const h = canvas.clientHeight || canvas.height || 0;
      if (w > 0 && h > 0) {
        anchor = screenToLngLat(map, w * 0.5, h * 0.7);
      }
    }
    if (!anchor) {
      const c = map.getCenter();
      anchor = { lng: c.lng, lat: c.lat };
    }

    const centreTile = lngLatToTile(anchor.lng, anchor.lat, z);
    let velocity: { dx: number; dy: number } | null = null;
    if (lastCentreTile) {
      const dxSigned = centreTile.x - lastCentreTile.x;
      const dySigned = centreTile.y - lastCentreTile.y;
      const dx = Math.abs(dxSigned);
      const dy = Math.abs(dySigned);
      const dz = Math.abs(z - lastCentreTile.z);
      if (dz >= 2 || dx + dy > TELEPORT_TILE_DELTA) {
        if (activeAbort) {
          activeAbort.abort();
          activeAbort = null;
        }
        lastVelocityTile = null;
      } else if (lastCentreTile.z === z && (dx + dy) >= 1) {
        velocity = { dx: dxSigned, dy: dySigned };
      }
    }
    if (!velocity && lastVelocityTile) velocity = lastVelocityTile;
    lastVelocityTile = velocity;
    lastCentreTile = { x: centreTile.x, y: centreTile.y, z };

    const sig = `${z}:${xMin},${yMin},${xMax},${yMax}:p${tilted ? 1 : 0}:a${anchor.lng.toFixed(3)},${anchor.lat.toFixed(3)}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    lastFiredAt = performance.now();

    const orthoOn = opts.isOrthoActive?.() ?? false;
    const slopeOn = false;
    const altitudeOn = false;
    const urls = buildPrefetchUrls(
      map,
      z, xMin, yMin, xMax, yMax, anchor, tilted, orthoOn,
      /* includeRing */ true,
      /* includeChildren */ true,
      /* includeParent */ true,
      slopeOn,
      altitudeOn,
    );

    if (velocity) {
      const cap = (1 << z) - 1;
      const dominantX = Math.abs(velocity.dx) >= Math.abs(velocity.dy);
      const stepX = dominantX ? Math.sign(velocity.dx) : 0;
      const stepY = dominantX ? 0 : Math.sign(velocity.dy);
      if (stepX !== 0 || stepY !== 0) {
        for (let i = 1; i <= PREDICTIVE_LEAD_TILES; i++) {
          const lx0 = stepX > 0 ? xMax + i : (stepX < 0 ? xMin - i : xMin);
          const lx1 = stepX !== 0 ? lx0 : xMax;
          const ly0 = stepY > 0 ? yMax + i : (stepY < 0 ? yMin - i : yMin);
          const ly1 = stepY !== 0 ? ly0 : yMax;
          for (let lx = Math.max(0, Math.min(cap, lx0)); lx <= Math.max(0, Math.min(cap, lx1)); lx++) {
            for (let ly = Math.max(0, Math.min(cap, ly0)); ly <= Math.max(0, Math.min(cap, ly1)); ly++) {
              urls.push(`/dem-tiles/${z}/${lx}/${ly}?pf=1`);
              if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${lx}/${ly}?pf=1`);
            }
          }
        }
      }
    }

    if (urls.length === 0) return;

    if (activeAbort) activeAbort.abort();
    activeAbort = dispatchBatch(urls, 'low');
  };

  const schedule = (): void => {
    if (disposed) return;
    if (scheduled != null) return;
    const elapsed = performance.now() - lastFiredAt;
    const wait = elapsed >= PREFETCH_THROTTLE_MS
      ? PREFETCH_POST_IDLE_DELAY_MS
      : Math.max(PREFETCH_POST_IDLE_DELAY_MS, PREFETCH_THROTTLE_MS - elapsed);
    scheduled = setTimeout(fire, wait);
  };

  const prewarmDestination = (
    lng: number,
    lat: number,
    zoom: number,
    prewarmOpts: PrewarmDestinationOptions = {},
  ): void => {
    if (disposed) return;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) return;

    const z = Math.max(PREFETCH_MIN_ZOOM, Math.min(PREFETCH_MAX_ZOOM, Math.round(zoom)));
    const radius = Math.max(0, Math.min(3, prewarmOpts.radius ?? 1));
    const orthoOn = prewarmOpts.withOrtho ?? (opts.isOrthoActive?.() ?? false);
    const slopeOn = opts.isSlopeActive?.() ?? false;
    const altitudeOn = opts.isAltitudeActive?.() ?? false;
    const includeChildren = prewarmOpts.includeChildren ?? true;

    const c = lngLatToTile(lng, lat, z);
    const cap = (1 << z) - 1;
    const xMin = Math.max(0, c.x - radius);
    const xMax = Math.min(cap, c.x + radius);
    const yMin = Math.max(0, c.y - radius);
    const yMax = Math.min(cap, c.y + radius);

    const anchor = { lng, lat };

    const urls: string[] = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push(`/dem-tiles/${z}/${x}/${y}?pf=1`);
        if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${x}/${y}?pf=1`);
        if (slopeOn) urls.push(slopePrefetchUrl(map, z, x, y));
        if (altitudeOn) urls.push(`/altitude-tiles/${z}/${x}/${y}?pf=1`);
      }
    }

    const extras = buildPrefetchUrls(
      map,
      z, xMin, yMin, xMax, yMax, anchor,
      /* tilted */ false,
      orthoOn,
      /* includeRing */ false,
      includeChildren,
      /* includeParent */ true,
      /* slopeOn */ false,
      /* altitudeOn */ false,
    );
    for (const u of extras) urls.push(u);

    if (urls.length === 0) return;

    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    lastSignature = '';
    lastFiredAt = 0;
    lastCentreTile = { x: c.x, y: c.y, z };
    lastVelocityTile = null;

    prewarmAbort = dispatchBatch(urls, 'high');
  };

  let lastIdleAt = performance.now();
  let pendingMoveendFallback: ReturnType<typeof setTimeout> | null = null;
  const MOVEEND_FALLBACK_DELAY_MS = 1800;
  const IDLE_RECENCY_MS = 1500;

  const onIdle = (): void => {
    lastIdleAt = performance.now();
    if (pendingMoveendFallback != null) {
      clearTimeout(pendingMoveendFallback);
      pendingMoveendFallback = null;
    }
    schedule();
  };
  map.on('idle', onIdle);

  const onMoveEnd = (): void => {
    if (disposed) return;
    if (pendingMoveendFallback != null) clearTimeout(pendingMoveendFallback);
    pendingMoveendFallback = setTimeout(() => {
      pendingMoveendFallback = null;
      if (disposed) return;
      if (performance.now() - lastIdleAt < IDLE_RECENCY_MS) return;
      schedule();
    }, MOVEEND_FALLBACK_DELAY_MS);
  };
  map.on('moveend', onMoveEnd);

  const onStyleLoad = (): void => {
    if (disposed) return;
    if (scheduled != null) return;
    scheduled = setTimeout(fire, 80);
  };
  map.on('style.load', onStyleLoad);

  const cancelOnUserGesture = (e: unknown): void => {
    const evt = e as { originalEvent?: unknown } | null | undefined;
    if (!evt || !evt.originalEvent) return;
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    if (prewarmAbort) {
      prewarmAbort.abort();
      prewarmAbort = null;
    }
    lastSignature = '';
    lastVelocityTile = null;
    if (scheduled != null) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    if (sw && sw.controller) {
      try { sw.controller.postMessage({ type: 'CANCEL_STALE_DEM' }); }
      catch { /* SW gone away */ }
      try { sw.controller.postMessage({ type: 'CANCEL_SLOPE_WORK' }); }
      catch { /* SW gone away */ }
      try { sw.controller.postMessage({ type: 'CANCEL_ALTITUDE_WORK' }); }
      catch { /* SW gone away */ }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map.on('movestart', cancelOnUserGesture as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map.on('zoomstart', cancelOnUserGesture as any);

  const handle: ViewportPrefetchHandle = {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (scheduled != null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      if (pendingMoveendFallback != null) {
        clearTimeout(pendingMoveendFallback);
        pendingMoveendFallback = null;
      }
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      if (prewarmAbort) {
        prewarmAbort.abort();
        prewarmAbort = null;
      }
      map.off('idle', onIdle);
      map.off('moveend', onMoveEnd);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.off('movestart', cancelOnUserGesture as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.off('zoomstart', cancelOnUserGesture as any);
      if (currentHandle === handle) currentHandle = null;
    },
    trigger: schedule,
    prewarmDestination,
  };

  if (currentHandle) {
    try { currentHandle.dispose(); } catch { /* ignore */ }
  }
  currentHandle = handle;
  return handle;
}
