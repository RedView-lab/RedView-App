// ---------------------------------------------------------------------------
// Viewport tile prefetch — Strava-style speculative warming.
// ---------------------------------------------------------------------------
// CRITICAL design constraint: this MUST never starve the foreground tiles
// the user is actively staring at. The Service Worker's IGN/Spain/Norway
// schedulers are LIFO (newest-first), so any prefetch enqueued AFTER a
// pan would be popped BEFORE the visible-tile requests Mapbox just issued
// — flipping the user-perceived order to "horizon loads first, foreground
// stays blurred forever". That bug was visible on tilted 3D mountain views
// (the Pyrenees / Chamonix shots): far ridges sharpened immediately, the
// near rocks under the camera stayed flat 30 m Mapbox for ~5 s.
//
// The fix is twofold:
//   1. Trigger ONLY on `idle` (NOT `moveend`). `idle` fires after Mapbox
//      reports every source loaded — i.e. the visible tiles are already
//      done. Prefetch can then safely consume the now-empty queue.
//   2. Add a small post-idle delay (`PREFETCH_POST_IDLE_DELAY_MS`) so any
//      late stragglers from `idle` (slope/altitude follow-ups, ortho
//      crossfade fetches) get the queue first.
//
// What we prefetch (anchor depends on view tilt):
//   * Pitch ≤ 25°: classic 1-tile RING outside visible bbox + the 4 z+1
//     children of the centre tile (predictive zoom-in).
//   * Pitch > 25° (3D view): RING is asymmetric — we ONLY warm tiles in
//     the user's likely pan direction (forward = away from camera) and
//     z+1 CHILDREN are anchored on the FOREGROUND (bottom of screen),
//     not the centre. This way the next pan-forward and the next zoom-in
//     are both pre-warmed where the user actually looks.
//
// Tagging: every prefetch URL carries `?pf=1` so it's filterable in
// devtools and the SW can — in a future patch — push them to the BOTTOM
// of the LIFO queue if it ever needs to.
//
// Safety summary:
//   * Never fires while Mapbox is still loading visible tiles (idle gate).
//   * `priority:'low'` on HTTP/2 so even on a shared connection the
//     user's next foreground burst preempts.
//   * Throttled to one cycle per ~600 ms; signature dedup skips if the
//     viewport hasn't changed.
//   * Skipped below z10 (Mapbox base is fine, no LiDAR engaged).
//   * Fire-and-forget; failures are silent.
// ---------------------------------------------------------------------------

import type { Map as MapboxMap, Point as MapboxPoint } from 'mapbox-gl';

const PREFETCH_MIN_ZOOM = 10;
const PREFETCH_MAX_ZOOM = 17;
const PREFETCH_RING = 1;
const PREFETCH_MAX_PER_CYCLE = 32;
const PREFETCH_THROTTLE_MS = 600;
// Wait this long AFTER `idle` before firing. `idle` already implies sources
// reported done, but this gives any follow-up fetch (slope build, ortho
// crossfade, terrain re-attach) breathing room before we add load.
const PREFETCH_POST_IDLE_DELAY_MS = 400;
// Above this pitch we treat the view as 3D-foreground-dominant: the user
// is looking at near rocks/snow, not the horizon. Anchor the z+1 children
// on the screen bottom and skip the horizon ring tiles.
const PITCH_FOREGROUND_THRESHOLD_DEG = 25;

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

  // Project a screen pixel back to (lng, lat). Wrapped in try/catch because
  // Mapbox `unproject` can throw during style transitions (style not ready
  // yet, transform out of date). On failure we just fall back to centre.
  const screenToLngLat = (x: number, y: number): { lng: number; lat: number } | null => {
    try {
      const point = { x, y } as MapboxPoint;
      const ll = map.unproject(point);
      if (!ll || !Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return null;
      return { lng: ll.lng, lat: ll.lat };
    } catch {
      return null;
    }
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

    // Skip absurd viewports (panned to date line, zoom too low etc.). 16
    // tiles wide is roughly a screen at z14 — beyond that prefetch is a
    // bandwidth waste, not a perf win.
    if (xMax - xMin > 16 || yMax - yMin > 16) return;

    const pitch = typeof map.getPitch === 'function' ? map.getPitch() : 0;
    const tilted = pitch >= PITCH_FOREGROUND_THRESHOLD_DEG;

    // Foreground anchor: in tilted view, the bottom-centre of the canvas
    // is what the user is closest to and most likely staring at. In flat
    // view, fall back to map centre.
    let anchor: { lng: number; lat: number } | null = null;
    if (tilted && typeof map.getCanvas === 'function') {
      const canvas = map.getCanvas();
      const w = canvas.clientWidth || canvas.width || 0;
      const h = canvas.clientHeight || canvas.height || 0;
      if (w > 0 && h > 0) {
        // Sample 70 % down the canvas — slightly above the bottom edge,
        // which on a typical 60° pitch is the camera's near focal point.
        anchor = screenToLngLat(w * 0.5, h * 0.7);
      }
    }
    if (!anchor) {
      const c = map.getCenter();
      anchor = { lng: c.lng, lat: c.lat };
    }

    const sig = `${z}:${xMin},${yMin},${xMax},${yMax}:p${tilted ? 1 : 0}:a${anchor.lng.toFixed(3)},${anchor.lat.toFixed(3)}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    lastFiredAt = performance.now();

    const orthoOn = opts.isOrthoActive?.() ?? false;
    const urls: string[] = [];
    const cap = (1 << z) - 1;

    // ── Ring of tiles immediately outside the visible bbox ──────────────
    // In tilted view we SKIP the ring entirely. The horizon tiles served
    // by the ring are exactly the cheap, low-zoom Mapbox-overlap tiles
    // that look fine even at low quality — and warming them was eating
    // queue slots that should go to the foreground children below.
    if (!tilted) {
      const rxMin = Math.max(0, xMin - PREFETCH_RING);
      const rxMax = Math.min(cap, xMax + PREFETCH_RING);
      const ryMin = Math.max(0, yMin - PREFETCH_RING);
      const ryMax = Math.min(cap, yMax + PREFETCH_RING);
      for (let x = rxMin; x <= rxMax; x++) {
        for (let y = ryMin; y <= ryMax; y++) {
          // Skip already-visible interior tiles — Mapbox is loading them.
          if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) continue;
          urls.push(`/dem-tiles/${z}/${x}/${y}?pf=1`);
          if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${x}/${y}?pf=1`);
        }
      }
    }

    // ── Predictive zoom-in: pre-warm z+1 children of the FOREGROUND ────
    // Anchored on the bottom-of-screen point in tilted view (= what the
    // user will zoom into next), or on map centre in flat view.
    if (z < PREFETCH_MAX_ZOOM) {
      const z1 = z + 1;
      const c = lngLatToTile(anchor.lng, anchor.lat, z1);
      const cap1 = (1 << z1) - 1;
      const candidates: Array<{ x: number; y: number }> = [
        { x: c.x, y: c.y },
        { x: c.x + 1, y: c.y },
        { x: c.x, y: c.y + 1 },
        { x: c.x + 1, y: c.y + 1 },
      ];
      // In tilted view also pre-warm the row of z+1 tiles JUST BELOW the
      // foreground anchor (further into the scene towards the camera).
      // These are the ones that take the longest because they're at high
      // zoom on the LiDAR pipeline AND stay visible the entire time the
      // user inspects the rocks in front of them.
      if (tilted) {
        candidates.push({ x: c.x - 1, y: c.y });
        candidates.push({ x: c.x - 1, y: c.y + 1 });
      }
      for (const t of candidates) {
        if (t.x < 0 || t.y < 0 || t.x > cap1 || t.y > cap1) continue;
        urls.push(`/dem-tiles/${z1}/${t.x}/${t.y}?pf=1`);
        if (orthoOn && z1 >= 11) urls.push(`/ortho-tiles/${z1}/${t.x}/${t.y}?pf=1`);
      }
    }

    if (urls.length === 0) return;
    const cap2 = Math.min(urls.length, PREFETCH_MAX_PER_CYCLE);
    const init: PriorityHintInit = { priority: 'low', cache: 'force-cache' };
    for (let i = 0; i < cap2; i++) {
      try {
        // `cache: 'force-cache'` means: if the SW already has this tile
        // in CacheStorage, return it without consulting the network. For
        // misses the SW runs its normal fetch path so freshness is
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
      ? PREFETCH_POST_IDLE_DELAY_MS
      : Math.max(PREFETCH_POST_IDLE_DELAY_MS, PREFETCH_THROTTLE_MS - elapsed);
    scheduled = setTimeout(fire, wait);
  };

  // Trigger ONLY on `idle`. `idle` fires after Mapbox confirms every source
  // has finished loading — by then the visible tile queue is empty and our
  // prefetch can safely consume the SW's per-provider scheduler without
  // displacing foreground tiles. Using `moveend` here was the previous bug:
  // moveend fires BEFORE Mapbox issues its tile requests, so the prefetch
  // entered the LIFO queue first and got popped first → "background loads
  // ultra-fast, foreground stays low-quality forever".
  map.on('idle', schedule);

  return {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (scheduled != null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      map.off('idle', schedule);
    },
    trigger: schedule,
  };
}
