// ---------------------------------------------------------------------------
// Viewport tile prefetch — Strava-style speculative warming.
// ---------------------------------------------------------------------------
// On every map idle / moveend we issue low-priority `fetch()` calls for the
// 1-tile ring just OUTSIDE the visible bbox plus the four z+1 children of
// the centre tile. The Service Worker (`public/sw-dem`) intercepts these,
// returns instantly when CacheStorage is hot, and otherwise fans out to
// IGN / Spain / Norway / Switzerland / AWS through the same per-provider
// concurrency limiters used by the visible-tile path — but at a LOWER H2
// stream priority (`priority: 'low'`), so the user's interactive pan tiles
// (priority: 'high') always preempt them on a shared connection.
//
// Net effect when the user finally pans / zooms:
//   * Ring tiles are already in CacheStorage → first paint = SW cache lookup
//     (~1–3 ms) instead of provider RTT (~50–400 ms cold).
//   * z+1 children pre-warmed → zoom-in transitions stay sharp without the
//     overzoomed-blur frame.
//
// Safety:
//   * Never preempts visible-tile fetches (priority:'low' vs 'high').
//   * Throttled to one cycle per ~500 ms — even on rapid pans we don't
//     stack requests faster than the queue can drain.
//   * Skipped entirely below z10 (Mapbox base is fine, no LiDAR engaged).
//   * Fire-and-forget; failures are silent (the SW already manages retry +
//     negative caching for real provider failures).
// ---------------------------------------------------------------------------

import type { Map as MapboxMap } from 'mapbox-gl';

const PREFETCH_MIN_ZOOM = 10;
const PREFETCH_MAX_ZOOM = 17;
const PREFETCH_RING = 1;
const PREFETCH_MAX_PER_CYCLE = 48;
const PREFETCH_THROTTLE_MS = 500;
const PREFETCH_INITIAL_DELAY_MS = 80;

// `priority` is a fairly recent fetch option (Chrome/Edge 101+, Safari 17+).
// Firefox ignores it without throwing. Typed loosely so we don't depend on
// lib.dom.d.ts having `RequestPriority` (some TS targets still don't).
type PriorityHintInit = RequestInit & { priority?: 'high' | 'low' | 'auto' };

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  const cap = n - 1;
  return {
    x: Math.max(0, Math.min(cap, x)),
    y: Math.max(0, Math.min(cap, y)),
  };
}

export interface ViewportPrefetchOptions {
  /** Returns true when the IGN ortho overlay is engaged on the map. */
  isOrthoActive?: () => boolean;
}

export interface ViewportPrefetchHandle {
  dispose: () => void;
  /** Force a prefetch cycle (useful after style switch). */
  trigger: () => void;
}

export function installViewportPrefetch(
  map: MapboxMap,
  opts: ViewportPrefetchOptions = {},
): ViewportPrefetchHandle {
  let lastSignature = '';
  let lastFiredAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

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

    // Skip absurd viewports (panned to date line, zoom too low etc.). 16
    // tiles wide is roughly a screen at z14 — beyond that prefetch is a
    // bandwidth waste, not a perf win.
    if (xMax - xMin > 16 || yMax - yMin > 16) return;

    const sig = `${z}:${xMin},${yMin},${xMax},${yMax}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    lastFiredAt = performance.now();

    const orthoOn = opts.isOrthoActive?.() ?? false;
    const urls: string[] = [];

    // ── Ring of tiles immediately outside the visible bbox ──────────────
    const cap = (1 << z) - 1;
    const rxMin = Math.max(0, xMin - PREFETCH_RING);
    const rxMax = Math.min(cap, xMax + PREFETCH_RING);
    const ryMin = Math.max(0, yMin - PREFETCH_RING);
    const ryMax = Math.min(cap, yMax + PREFETCH_RING);
    for (let x = rxMin; x <= rxMax; x++) {
      for (let y = ryMin; y <= ryMax; y++) {
        // Skip already-visible interior tiles — Mapbox is already loading them.
        if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) continue;
        urls.push(`/dem-tiles/${z}/${x}/${y}`);
        if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${x}/${y}`);
      }
    }

    // ── Predictive zoom-in: pre-warm the four z+1 children of centre ────
    if (z < PREFETCH_MAX_ZOOM) {
      const center = map.getCenter();
      const z1 = z + 1;
      const c = lngLatToTile(center.lng, center.lat, z1);
      const cap1 = (1 << z1) - 1;
      const candidates: Array<{ x: number; y: number }> = [
        { x: c.x, y: c.y },
        { x: c.x + 1, y: c.y },
        { x: c.x, y: c.y + 1 },
        { x: c.x + 1, y: c.y + 1 },
      ];
      for (const t of candidates) {
        if (t.x < 0 || t.y < 0 || t.x > cap1 || t.y > cap1) continue;
        urls.push(`/dem-tiles/${z1}/${t.x}/${t.y}`);
        if (orthoOn && z1 >= 11) urls.push(`/ortho-tiles/${z1}/${t.x}/${t.y}`);
      }
    }

    if (urls.length === 0) return;
    const cap2 = Math.min(urls.length, PREFETCH_MAX_PER_CYCLE);
    const init: PriorityHintInit = { priority: 'low', cache: 'force-cache' };
    for (let i = 0; i < cap2; i++) {
      try {
        // `cache: 'force-cache'` here means: if the SW already has this
        // tile in CacheStorage, return it without consulting the network.
        // For misses the SW runs its normal fetch path, so freshness is
        // unaffected (epoch invalidation still wipes everything).
        void fetch(urls[i], init).catch(() => undefined);
      } catch {
        /* fetch unavailable — should not happen in browsers */
      }
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    if (scheduled != null) return;
    const elapsed = performance.now() - lastFiredAt;
    const wait = elapsed >= PREFETCH_THROTTLE_MS
      ? PREFETCH_INITIAL_DELAY_MS
      : PREFETCH_THROTTLE_MS - elapsed;
    scheduled = setTimeout(fire, wait);
  };

  map.on('idle', schedule);
  map.on('moveend', schedule);

  return {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (scheduled != null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      map.off('idle', schedule);
      map.off('moveend', schedule);
    },
    trigger: schedule,
  };
}
