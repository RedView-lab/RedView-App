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
//   * Pitch ≤ 25°: 1-tile RING outside visible bbox + the 4 z+1 children
//     of the centre tile + 1 parent z-1 tile (instant downsample fallback
//     if the user zooms out).
//   * Pitch > 25° (3D view): RING is skipped; z+1 CHILDREN are anchored
//     on the FOREGROUND (bottom of screen), not the centre, plus 2 extra
//     "deeper-toward-camera" tiles. Parent z-1 still warmed.
//
// Multi-fetch strategy:
//   All URLs in a cycle are dispatched through a single Promise.allSettled
//   batch sharing one AbortController. This way:
//     * The HTTP/2 multiplexer can pipeline all tile streams in parallel
//       on each origin (vs. for-loop firing which is also parallel but
//       gives no completion signal).
//     * If a TELEPORT (search bar, easeTo to far point, large pan) fires
//       a new cycle while the previous batch is still in flight, the old
//       batch is aborted *immediately* — its bandwidth is freed for the
//       new destination instead of competing with it.
//
// Teleport pre-warm:
//   `prewarmDestination(lng, lat, zoom)` is exported via the module-level
//   singleton `getViewportPrefetch()`. Search bar / programmatic flyTo
//   callers invoke it BEFORE jumpTo so the SW kicks off DEM/ortho fetches
//   for the destination viewport during the camera animation (or during
//   the few hundred ms of style/transition latency around `jumpTo`).
//   This is the difference between a Strava-style "instant" feel and the
//   classic "I see a flat brown blob for 2 s after teleporting".
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
//   * AbortController is reset on dispose, on teleport, and on every new
//     cycle — no zombie batches survive a search-bar jump.
// ---------------------------------------------------------------------------

import type { Map as MapboxMap, Point as MapboxPoint } from 'mapbox-gl';

const PREFETCH_MIN_ZOOM = 10;
const PREFETCH_MAX_ZOOM = 17;
const PREFETCH_RING = 1;
const PREFETCH_MAX_PER_CYCLE = 48;
const PREFETCH_THROTTLE_MS = 600;
// Wait this long AFTER `idle` before firing. `idle` already implies sources
// reported done, but this gives any follow-up fetch (slope build, ortho
// crossfade, terrain re-attach) breathing room before we add load.
const PREFETCH_POST_IDLE_DELAY_MS = 400;
// Above this pitch we treat the view as 3D-foreground-dominant: the user
// is looking at near rocks/snow, not the horizon. Anchor the z+1 children
// on the screen bottom and skip the horizon ring tiles.
const PITCH_FOREGROUND_THRESHOLD_DEG = 25;
// Manhattan-distance in tiles between two consecutive idle centres above
// which we treat the move as a "teleport": cancel the previous batch
// (now wasted bandwidth) and skip the throttle so the new destination
// starts warming immediately. Calibrated from search-bar jumps which can
// span thousands of tiles, vs. user pans which stay within ~3-5 tiles.
const TELEPORT_TILE_DELTA = 8;

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
  /** Returns true when the slope overlay layer is visible on the map. */
  isSlopeActive?: () => boolean;
  /** Returns true when the altitude overlay layer is visible on the map. */
  isAltitudeActive?: () => boolean;
}

export interface PrewarmDestinationOptions {
  /** Override ortho-overlay state for the destination (defaults to current). */
  withOrtho?: boolean;
  /** Optional radius (tiles) around the destination to warm. Default 1 (3×3). */
  radius?: number;
  /** Set false to skip z+1 children warming (default true). */
  includeChildren?: boolean;
}

export interface ViewportPrefetchHandle {
  dispose: () => void;
  /** Force a prefetch cycle (useful after style switch). */
  trigger: () => void;
  /**
   * Eagerly warm the SW cache for a known future viewport (search bar
   * teleport, programmatic easeTo, etc.). Runs in parallel with the
   * camera animation so by the time the camera arrives, the foreground
   * tiles are already in CacheStorage. Aborts any in-flight ambient
   * prefetch batch first — the destination wins the bandwidth.
   */
  prewarmDestination: (
    lng: number,
    lat: number,
    zoom: number,
    opts?: PrewarmDestinationOptions,
  ) => void;
}

// ───────────────────────────────────────────────────────────────────────────
// Module-level singleton.
//
// There is exactly one Mapbox map per session. Exposing the handle this way
// lets feature code that doesn't have access to the controller ref (search
// bar, viewport-controls easeTo) call `prewarmDestination` without having
// to thread a prop through a dozen layers of components.
// ───────────────────────────────────────────────────────────────────────────
let currentHandle: ViewportPrefetchHandle | null = null;

export function getViewportPrefetch(): ViewportPrefetchHandle | null {
  return currentHandle;
}

export function installViewportPrefetch(
  map: MapboxMap,
  opts: ViewportPrefetchOptions = {},
): ViewportPrefetchHandle {
  let lastSignature = '';
  let lastFiredAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Single AbortController per in-flight batch. A new fire (ambient or
  // prewarm) aborts the previous one. AbortController is cheap to create
  // and there's no API to "remove a request from a batch", so this is the
  // canonical way to cancel mid-flight fetches.
  let activeAbort: AbortController | null = null;

  // Last centre tile observed at fire time. Used to detect teleports
  // between two idle events (e.g. search-bar jump): if the next centre
  // is more than TELEPORT_TILE_DELTA tiles away at the same zoom, we
  // treat it as a discontinuity and abort the previous batch.
  let lastCentreTile: { x: number; y: number; z: number } | null = null;

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

  // Dispatch every URL in `urls` through a single AbortController-shared
  // batch. Returns the controller so the caller can stash it as the
  // active one (and abort it on next cycle). Promise.allSettled lets the
  // browser HTTP/2 stack pipeline streams in parallel on each origin.
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
        // `cache: 'force-cache'` means: if the SW already has this tile
        // in CacheStorage, return it without consulting the network. For
        // misses the SW runs its normal fetch path so freshness is
        // unaffected (epoch invalidation still wipes everything).
        promises.push(fetch(urls[i], init).catch(() => undefined));
      } catch {
        /* fetch unavailable — should not happen in browsers */
      }
    }
    // Fire all in parallel — HTTP/2 multiplexes streams on each origin
    // and the SW per-provider concurrency caps already throttle naturally.
    void Promise.allSettled(promises);
    return controller;
  };

  // Build the URL list for an arbitrary anchor / zoom / bbox.
  // Used by both the ambient `fire()` cycle and `prewarmDestination`.
  const buildUrls = (
    z: number,
    bboxXMin: number,
    bboxYMin: number,
    bboxXMax: number,
    bboxYMax: number,
    anchor: { lng: number; lat: number },
    tilted: boolean,
    orthoOn: boolean,
    includeRing: boolean,
    includeChildren: boolean,
    includeParent: boolean,
    slopeOn: boolean = false,
    altitudeOn: boolean = false,
  ): string[] => {
    const urls: string[] = [];
    const cap = (1 << z) - 1;

    // Helper: derived overlays (slope/altitude) are SW-built from the DEM.
    // Warming them at the same time as the DEM tile means the SW pipeline
    // (Horn, decode, PNG encode) runs while the user is still panning,
    // not after they stop. Slope/altitude have their own tile-zoom range
    // (minzoom: 6, maxzoom: 17 in the source spec) — we let the SW reject
    // out-of-range requests rather than gate here.
    const pushDerived = (z: number, x: number, y: number) => {
      if (slopeOn) urls.push(`/slope-tiles/${z}/${x}/${y}?pf=1`);
      if (altitudeOn) urls.push(`/altitude-tiles/${z}/${x}/${y}?pf=1`);
    };

    if (includeRing && !tilted) {
      const rxMin = Math.max(0, bboxXMin - PREFETCH_RING);
      const rxMax = Math.min(cap, bboxXMax + PREFETCH_RING);
      const ryMin = Math.max(0, bboxYMin - PREFETCH_RING);
      const ryMax = Math.min(cap, bboxYMax + PREFETCH_RING);
      for (let x = rxMin; x <= rxMax; x++) {
        for (let y = ryMin; y <= ryMax; y++) {
          if (x >= bboxXMin && x <= bboxXMax && y >= bboxYMin && y <= bboxYMax) continue;
          urls.push(`/dem-tiles/${z}/${x}/${y}?pf=1`);
          if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${x}/${y}?pf=1`);
          pushDerived(z, x, y);
        }
      }
    }

    if (includeChildren && z < PREFETCH_MAX_ZOOM) {
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
        pushDerived(z1, t.x, t.y);
      }
    }

    // Parent z-1: instant downsample fallback if user zooms out. One
    // tile covers the whole current view so it's nearly free, but it
    // makes pinch-zoom-out feel snappy: Mapbox renders the wider view
    // from this lower-z tile while higher-z neighbours load.
    if (includeParent && z > 4) {
      const zM = z - 1;
      const p = lngLatToTile(anchor.lng, anchor.lat, zM);
      const capM = (1 << zM) - 1;
      if (p.x >= 0 && p.y >= 0 && p.x <= capM && p.y <= capM) {
        urls.push(`/dem-tiles/${zM}/${p.x}/${p.y}?pf=1`);
        if (orthoOn && zM >= 11) urls.push(`/ortho-tiles/${zM}/${p.x}/${p.y}?pf=1`);
        pushDerived(zM, p.x, p.y);
      }
    }

    return urls;
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
        anchor = screenToLngLat(w * 0.5, h * 0.7);
      }
    }
    if (!anchor) {
      const c = map.getCenter();
      anchor = { lng: c.lng, lat: c.lat };
    }

    // ── Teleport detection ──────────────────────────────────────────────
    // If the centre tile jumped by more than TELEPORT_TILE_DELTA at the
    // same zoom (or zoom changed by ≥2), the previous batch is targeting
    // a now-irrelevant region. Abort it so its in-flight streams stop
    // competing with the new destination.
    const centreTile = lngLatToTile(anchor.lng, anchor.lat, z);
    if (lastCentreTile && activeAbort) {
      const dx = Math.abs(centreTile.x - lastCentreTile.x);
      const dy = Math.abs(centreTile.y - lastCentreTile.y);
      const dz = Math.abs(z - lastCentreTile.z);
      if (dz >= 2 || dx + dy > TELEPORT_TILE_DELTA) {
        activeAbort.abort();
        activeAbort = null;
      }
    }
    lastCentreTile = { x: centreTile.x, y: centreTile.y, z };

    const sig = `${z}:${xMin},${yMin},${xMax},${yMax}:p${tilted ? 1 : 0}:a${anchor.lng.toFixed(3)},${anchor.lat.toFixed(3)}`;
    if (sig === lastSignature) return;
    lastSignature = sig;
    lastFiredAt = performance.now();

    const orthoOn = opts.isOrthoActive?.() ?? false;
    const slopeOn = opts.isSlopeActive?.() ?? false;
    const altitudeOn = opts.isAltitudeActive?.() ?? false;
    const urls = buildUrls(
      z, xMin, yMin, xMax, yMax, anchor, tilted, orthoOn,
      /* includeRing */ true,
      /* includeChildren */ true,
      /* includeParent */ true,
      slopeOn,
      altitudeOn,
    );

    if (urls.length === 0) return;

    // Abort any still-running ambient batch from the previous cycle.
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

  // ── prewarmDestination: search-bar / programmatic-jump entry point ──
  //
  // Called BEFORE `map.jumpTo` / `map.flyTo`. We don't have a real bbox
  // because the canvas hasn't moved yet, so we synthesize one: a `radius`-
  // tile square centred on the destination (default 1 → 3×3). Combined
  // with z+1 children (4 tiles) and a parent z-1 (1 tile), a typical
  // search-bar jump kicks off ~14 tiles before the camera moves.
  //
  // Crucially, this fires with `priority:'high'` because by the time the
  // user picks a search result, they ARE staring at the destination — the
  // destination IS the foreground. Ambient (idle-driven) prefetch remains
  // `priority:'low'`.
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

    // 1. Visible bbox tiles for the destination — Mapbox would normally
    //    fetch these on `jumpTo`, but firing them now buys us the camera-
    //    animation duration as head-start.
    const urls: string[] = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push(`/dem-tiles/${z}/${x}/${y}?pf=1`);
        if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${x}/${y}?pf=1`);
        if (slopeOn) urls.push(`/slope-tiles/${z}/${x}/${y}?pf=1`);
        if (altitudeOn) urls.push(`/altitude-tiles/${z}/${x}/${y}?pf=1`);
      }
    }

    // 2. z+1 children + z-1 parent for instant zoom transitions after
    //    arrival. Reuse buildUrls with ring disabled (already covered by
    //    the destination bbox itself).
    const extras = buildUrls(
      z, xMin, yMin, xMax, yMax, anchor,
      /* tilted */ false,
      orthoOn,
      /* includeRing */ false,
      includeChildren,
      /* includeParent */ true,
      slopeOn,
      altitudeOn,
    );
    for (const u of extras) urls.push(u);

    if (urls.length === 0) return;

    // Abort ambient batch — it's targeting the OLD origin region.
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    // Reset signature & throttle so the ambient `idle` that fires right
    // after `jumpTo` actually refines on top of our prewarm rather than
    // dedup-skipping it.
    lastSignature = '';
    lastFiredAt = 0;
    lastCentreTile = { x: c.x, y: c.y, z };

    // Destination-prewarm runs at HIGH priority. We deliberately do NOT
    // store this controller as `activeAbort`: we want it to run to
    // completion even if the user pans afterward — the destination tiles
    // are useful for ~30 s of panning around.
    dispatchBatch(urls, 'high');
  };

  // Trigger ONLY on `idle`. `idle` fires after Mapbox confirms every source
  // has finished loading — by then the visible tile queue is empty and our
  // prefetch can safely consume the SW's per-provider scheduler without
  // displacing foreground tiles. Using `moveend` here was the previous bug:
  // moveend fires BEFORE Mapbox issues its tile requests, so the prefetch
  // entered the LIFO queue first and got popped first → "background loads
  // ultra-fast, foreground stays low-quality forever".
  map.on('idle', schedule);

  const handle: ViewportPrefetchHandle = {
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (scheduled != null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      map.off('idle', schedule);
      if (currentHandle === handle) currentHandle = null;
    },
    trigger: schedule,
    prewarmDestination,
  };

  // Replace any previous handle (defensive — there should be only one map).
  if (currentHandle) {
    try { currentHandle.dispose(); } catch { /* ignore */ }
  }
  currentHandle = handle;
  return handle;
}
