/**
 * Live cast-shadow overlay backed by a single Mapbox `ImageSource`.
 *
 * v3 — Apr 21 2026 — stability/precision pass.
 *
 * Symptom we're fixing: during a zoom (or rapid pan) the shadow briefly
 * "jumps" to a wrong location for a few frames before settling back. Three
 * root causes were addressed:
 *
 *  1. Texture-swap gap. `ImageSource.updateImage({url, coordinates})`
 *     swaps the *coordinates* synchronously but loads the new URL async.
 *     During that ~1–3 frame window Mapbox draws the previous texture
 *     stretched onto the new geographic coordinates → the shadow appears
 *     in the wrong place. Fix: pre-decode the blob via
 *     `HTMLImageElement.decode()` BEFORE calling `updateImage`. The URL
 *     is then in the browser's image cache, so Mapbox's internal load
 *     resolves on the same frame as the coordinate update.
 *
 *  2. Race condition. Multiple `sample+compute` rounds could finish out
 *     of order; the older result would clobber the newer one. Fix: a
 *     monotonic generation counter; any worker ack older than the
 *     current generation is discarded.
 *
 *  3. Edge starvation on pan/zoom. After a resample the image was
 *     pinned to the exact viewport bounds, so any subsequent pan/zoom
 *     immediately revealed shadow-less pixels at the edges. Fix: sample
 *     with a configurable overshoot (default 15 %) so the user can pan
 *     within that buffer without seeing a hole.
 *
 * Additional precision/perf work:
 *
 *  • Grid resolution is now adaptive to the actual map canvas size,
 *    capped at GRID_MAX_W × GRID_MAX_H (1600 × 1200) so large monitors
 *    get sharper shadows without blowing up worker time.
 *  • Resample is scheduled on both `moveend` and `zoomend`; debounce
 *    dropped from 180 ms → 80 ms (still long enough to absorb a single
 *    moveend storm but no longer perceptible).
 *  • Worker requests are strictly serialized: at most one inflight + one
 *    pending. Intermediate requests collapse into the pending slot, so
 *    a long zoom storm produces O(1) work instead of one job per event.
 */

import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, ImageSource } from 'mapbox-gl';

const SOURCE_ID = 'shadow-image';
const LAYER_ID = 'shadow-image';

// Debounce after move/zoom end before triggering a resample. Short enough
// to feel responsive, long enough to coalesce a burst of events.
const SAMPLE_DEBOUNCE_MS = 80;

// Adaptive grid bounds. Small floor so we don't waste cycles on tiny
// viewports; large cap so Retina/4K monitors still get crisp output
// without exploding the worker sweep cost (≈linear in W×H).
const GRID_MIN_W = 768;
const GRID_MIN_H = 576;
const GRID_MAX_W = 1600;
const GRID_MAX_H = 1200;

// Geographic overshoot applied to the sampled bounds. Keeps the cast
// shadow filling the viewport during small pans/zooms that happen
// between resamples.
const BOUNDS_OVERSHOOT = 0.15;

// Time-to-live for revoked blob URLs after a swap. Mapbox finishes
// uploading the new texture in well under this window.
const BLOB_REVOKE_DELAY_MS = 1500;

export interface UseShadowImageOptions {
  enabled: boolean;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  /** 0..1 */
  opacity: number;
}

interface SampleAck { id: number; type: 'sample-ok'; filled: number; total: number; tooMany?: boolean }
interface ComputeAck { id: number; type: 'compute-ok'; blob: Blob; bounds: [number, number, number, number] }
interface ComputeEmpty { id: number; type: 'compute-empty' }
interface ResetAck { id: number; type: 'reset-ok' }
interface ErrAck { id: number; type: 'error'; message: string }
type WorkerAck = SampleAck | ComputeAck | ComputeEmpty | ResetAck | ErrAck;

/**
 * Cast-shadow visibility curve.
 *   alt ≥  0°  : full strength (1.0) — shadows are at their longest and most
 *                dramatic right at sunrise/sunset; that's exactly when the
 *                user expects to see them.
 *   0° → −3°  : smooth fade-out as the sun crosses the horizon.
 *   alt ≤ −3° : 0 (no cast shadow; the night veil takes over).
 */
function shadowVisibility(altitudeDeg: number): number {
  if (altitudeDeg >= 0) return 1;
  if (altitudeDeg <= -3) return 0;
  const t = (altitudeDeg + 3) / 3; // 0 at -3°, 1 at 0°
  return t * t * (3 - 2 * t);
}

/**
 * Twilight darkening curve. Returns 0..1 alpha for a uniform black veil that
 * eases the map from full daylight into night through the standard twilight
 * phases:
 *   alt > +1°  : 0   (full daylight, no veil)
 *   alt 0°     : light bluing begins
 *   -6° civil  : ~0.30
 *   -12° nautical: ~0.55
 *   -18° astro : ~0.72 (capped — keep terrain readable)
 */
function nightVeilAlpha(altitudeDeg: number): number {
  if (altitudeDeg >= 1) return 0;
  // Smooth cubic ramp from +1° to -18°, then clamp.
  const t = Math.max(0, Math.min(1, (1 - altitudeDeg) / 19));
  const eased = t * t * (3 - 2 * t);
  return eased * 0.72;
}

/**
 * Pick a DEM zoom that keeps the sample density close to one DEM pixel per
 * grid cell. Bounded so we never explode the tile count or under-resolve.
 */
function chooseDemZoom(map: MapboxMap, gridW: number): number {
  const z = Math.round(map.getZoom());
  const bounds = map.getBounds();
  if (!bounds) return Math.min(14, Math.max(10, z));
  const w = bounds.getWest();
  const e = bounds.getEast();
  const lat = (bounds.getNorth() + bounds.getSouth()) / 2;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonExtentM = ((e - w) * Math.PI * 6378137 * cosLat) / 180;
  const targetMpp = lonExtentM / gridW;
  // World metres per pixel at zoom Z and the given latitude.
  // demZ such that 40075016.686 * cosLat / (256 * 2^z) ≈ targetMpp
  const ideal = Math.log2((40075016.686 * Math.abs(cosLat)) / (256 * targetMpp));
  return Math.max(10, Math.min(14, Math.round(ideal)));
}

/**
 * Compute the actual grid resolution for the current canvas, capped to
 * the GRID_MAX_* envelope and floored at GRID_MIN_*. The aspect ratio
 * always matches the viewport so the resampled shadow doesn't get
 * non-uniformly stretched.
 */
function chooseGridSize(map: MapboxMap): { gridW: number; gridH: number } {
  const canvas = map.getCanvas();
  const cw = canvas.width || canvas.clientWidth || GRID_MIN_W;
  const ch = canvas.height || canvas.clientHeight || GRID_MIN_H;
  const aspect = cw / Math.max(1, ch);
  let w = Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, cw));
  let h = Math.round(w / aspect);
  if (h > GRID_MAX_H) {
    h = GRID_MAX_H;
    w = Math.round(h * aspect);
  }
  if (h < GRID_MIN_H) {
    h = GRID_MIN_H;
    w = Math.round(h * aspect);
  }
  // Final clamp so no axis ever exceeds the cap (rounding could push 1px over).
  w = Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, w));
  h = Math.max(GRID_MIN_H, Math.min(GRID_MAX_H, h));
  return { gridW: w, gridH: h };
}

/**
 * Apply a symmetric geographic overshoot to a bounds tuple. Latitude is
 * clamped to the Web Mercator usable range so the worker never receives
 * out-of-domain coordinates.
 */
function withOvershoot(
  b: [number, number, number, number],
  factor: number,
): [number, number, number, number] {
  const [w, s, e, n] = b;
  const dx = (e - w) * factor;
  const dy = (n - s) * factor;
  const ws = w - dx;
  const es = e + dx;
  const ss = Math.max(-85.05, s - dy);
  const ns = Math.min(85.05, n + dy);
  // Clamp longitudes to ±180 — viewports near the antimeridian are
  // effectively unsupported by the single-source design anyway.
  return [Math.max(-180, ws), ss, Math.min(180, es), ns];
}

/**
 * Pre-decode a blob URL so the subsequent `ImageSource.updateImage` call
 * sees it as already-cached and resolves on the same frame as the
 * coordinate swap. Returns once the bitmap is ready (or immediately on
 * any failure — the caller still proceeds; worst case we just lose the
 * gap-elimination benefit for that one frame).
 */
async function preloadBlobUrl(url: string): Promise<void> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.decode) {
      await img.decode();
    } else {
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }
  } catch {
    /* ignore — we'll just have a (very small) chance of a 1-frame swap gap */
  }
}

export function useShadowImage(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseShadowImageOptions,
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastBlobUrlRef = useRef<string | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const sampledRef = useRef(false);
  /**
   * Bounds last successfully sampled (with overshoot already applied).
   * Used as the geographic anchor for the displayed image until the next
   * resample completes.
   */
  const sampledBoundsRef = useRef<[number, number, number, number] | null>(null);
  // Promise resolvers keyed by request id so we can await each round-trip.
  const pendingRef = useRef(new Map<number, (a: WorkerAck) => void>());

  // Generation token. Incremented on every new sample-and-compute run; any
  // ack belonging to an older generation is dropped before it can clobber
  // newer state.
  const sampleGenRef = useRef(0);
  // Strict serialization: at most one inflight resample, plus one pending
  // slot that future requests collapse into.
  const inflightRef = useRef(false);
  const pendingResampleRef = useRef(false);

  // ── Worker lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    const worker = new Worker(
      new URL('../lib/shadowWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerAck>) => {
      const resolver = pendingRef.current.get(e.data.id);
      if (resolver) {
        pendingRef.current.delete(e.data.id);
        resolver(e.data);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      pendingRef.current.clear();
      if (lastBlobUrlRef.current) {
        URL.revokeObjectURL(lastBlobUrlRef.current);
        lastBlobUrlRef.current = null;
      }
    };
  }, []);

  // ── Source / layer ensure & teardown ──────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const ensureSourceAndLayer = (initialBlobUrl: string, coords: [[number, number], [number, number], [number, number], [number, number]]) => {
      if (!map.getSource(SOURCE_ID)) {
        try {
          map.addSource(SOURCE_ID, {
            type: 'image',
            url: initialBlobUrl,
            coordinates: coords,
          } as never);
        } catch (err) {
          console.warn('[shadow] addSource failed', err);
          return;
        }
      }
      if (!map.getLayer(LAYER_ID)) {
        try {
          map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            // Standard style requires an explicit slot, otherwise the layer
            // lands under the satellite imagery and stays invisible.
            slot: 'top',
            paint: {
              'raster-opacity': 1,
              'raster-fade-duration': 0,
              'raster-resampling': 'linear',
            },
          } as never);
        } catch (err) {
          console.warn('[shadow] addLayer failed', err);
        }
      }
    };

    const removeSourceAndLayer = () => {
      try { if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID); } catch { /* */ }
      try { if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID); } catch { /* */ }
      sampledRef.current = false;
      sampledBoundsRef.current = null;
    };

    let cancelled = false;

    const post = <T extends WorkerAck>(msg: object): Promise<T> => {
      const w = workerRef.current;
      if (!w) return Promise.reject(new Error('worker not ready'));
      const id = ++reqIdRef.current;
      return new Promise<T>((resolve) => {
        pendingRef.current.set(id, resolve as (a: WorkerAck) => void);
        w.postMessage({ ...msg, id });
      });
    };

    const runSampleAndCompute = async () => {
      if (cancelled || !map.getStyle()) return;
      const o = optsRef.current;
      if (!o.enabled) return;

      // Take the next generation token. Any in-flight ack with an older
      // token will be ignored when it returns.
      const myGen = ++sampleGenRef.current;

      const rawBounds = map.getBounds();
      if (!rawBounds) return;
      const sampledBounds = withOvershoot([
        rawBounds.getWest(),
        rawBounds.getSouth(),
        rawBounds.getEast(),
        rawBounds.getNorth(),
      ], BOUNDS_OVERSHOOT);
      const { gridW, gridH } = chooseGridSize(map);
      const demZoom = chooseDemZoom(map, gridW);

      const sampleAck = await post<SampleAck | ErrAck>({
        type: 'sample',
        bounds: sampledBounds,
        gridW,
        gridH,
        demZoom,
      });
      if (cancelled || myGen !== sampleGenRef.current) return;
      if (sampleAck.type === 'error') {
        console.warn('[shadow] sample failed', sampleAck.message);
        return;
      }
      if (sampleAck.tooMany) {
        console.warn('[shadow] sample skipped: viewport spans too many DEM tiles');
        removeSourceAndLayer();
        return;
      }
      if (sampleAck.filled === 0) {
        console.warn('[shadow] sample empty: no DEM coverage in viewport', { demZoom, bounds: sampledBounds });
        removeSourceAndLayer();
        return;
      }
      sampledRef.current = true;
      sampledBoundsRef.current = sampledBounds;
      await runComputeAndApply(sampledBounds, myGen);
    };

    /**
     * Compute the shadow for the current sun and push the result into the
     * single ImageSource. The `gen` token is checked at every async
     * boundary so a stale path can never clobber a fresher one.
     */
    const runComputeAndApply = async (
      b: [number, number, number, number],
      gen: number,
    ) => {
      if (cancelled || !sampledRef.current) return;
      if (gen !== sampleGenRef.current) return;
      const o = optsRef.current;
      if (!o.enabled) return;
      const visibility = shadowVisibility(o.sunAltitudeDeg);
      const veil = nightVeilAlpha(o.sunAltitudeDeg) * o.opacity;
      // Nothing to draw at all (sun fully up AND veil zero — only happens
      // when user disabled shadows; handled above).
      if (visibility <= 0 && veil <= 0) {
        if (map.getLayer(LAYER_ID)) {
          try { map.setPaintProperty(LAYER_ID, 'raster-opacity', 0); } catch { /* */ }
        }
        return;
      }

      const ack = await post<ComputeAck | ComputeEmpty | ErrAck>({
        type: 'compute',
        sunAzDeg: o.sunAzimuthDeg,
        sunAltDeg: o.sunAltitudeDeg,
        opacity: o.opacity * visibility,
        nightFloor: veil,
      });
      if (cancelled) return;
      // Compute-only paths (sun/opacity tweaks) re-use the current
      // generation; only drop if a newer SAMPLE has bumped it past us.
      if (gen !== sampleGenRef.current) return;
      if (ack.type !== 'compute-ok') return;

      const url = URL.createObjectURL(ack.blob);
      const coords: [[number, number], [number, number], [number, number], [number, number]] = [
        [b[0], b[3]],
        [b[2], b[3]],
        [b[2], b[1]],
        [b[0], b[1]],
      ];

      // Pre-decode the blob so the subsequent updateImage swap is
      // single-frame (eliminates the "wrong place for a few frames"
      // flicker during zoom).
      await preloadBlobUrl(url);
      if (cancelled || gen !== sampleGenRef.current) {
        URL.revokeObjectURL(url);
        return;
      }

      ensureSourceAndLayer(url, coords);
      const src = map.getSource(SOURCE_ID) as ImageSource | undefined;
      if (src) {
        try {
          src.updateImage({ url, coordinates: coords });
          if (map.getLayer(LAYER_ID)) {
            map.setPaintProperty(LAYER_ID, 'raster-opacity', 1);
          }
        } catch (err) {
          console.warn('[shadow] updateImage failed', err);
        }
      }
      // Revoke the previous blob URL on the next tick so Mapbox finishes
      // decoding the new one first (avoids a 1-frame transparent gap).
      const prev = lastBlobUrlRef.current;
      lastBlobUrlRef.current = url;
      if (prev) {
        setTimeout(() => URL.revokeObjectURL(prev), BLOB_REVOKE_DELAY_MS);
      }
    };

    /**
     * Strict serialization: only one resample runs at a time. Concurrent
     * requests collapse into a single pending slot so a long zoom storm
     * costs O(1) work instead of one job per event.
     */
    const requestResample = () => {
      if (inflightRef.current) {
        pendingResampleRef.current = true;
        return;
      }
      inflightRef.current = true;
      runSampleAndCompute()
        .catch((err) => console.warn('[shadow] resample error', err))
        .finally(() => {
          inflightRef.current = false;
          if (pendingResampleRef.current && !cancelled && optsRef.current.enabled) {
            pendingResampleRef.current = false;
            requestResample();
          }
        });
    };

    // Schedule a (debounced) full resample after the user stops moving.
    const scheduleSample = () => {
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
      }
      sampleTimerRef.current = (setTimeout(() => {
        sampleTimerRef.current = null;
        requestResample();
      }, SAMPLE_DEBOUNCE_MS) as unknown) as number;
    };

    if (!opts.enabled) {
      removeSourceAndLayer();
      return () => { cancelled = true; };
    }

    // Initial run.
    scheduleSample();

    const onMoveEnd = () => scheduleSample();
    const onZoomEnd = () => scheduleSample();
    const onStyleLoad = () => {
      sampledRef.current = false;
      sampledBoundsRef.current = null;
      scheduleSample();
    };
    map.on('moveend', onMoveEnd);
    map.on('zoomend', onZoomEnd);
    map.on('style.load', onStyleLoad);

    // Compute-only updater for sun/opacity changes.
    (map as unknown as { __shadowImageRecompute?: () => void }).__shadowImageRecompute = () => {
      if (!sampledRef.current || !sampledBoundsRef.current) {
        scheduleSample();
        return;
      }
      // Compute-only path — re-uses the current generation so the
      // race-cancel guards still catch a SAMPLE that lands afterwards.
      runComputeAndApply(sampledBoundsRef.current, sampleGenRef.current).catch(() => { /* */ });
    };

    return () => {
      cancelled = true;
      map.off('moveend', onMoveEnd);
      map.off('zoomend', onZoomEnd);
      map.off('style.load', onStyleLoad);
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      pendingResampleRef.current = false;
      delete (map as unknown as { __shadowImageRecompute?: () => void }).__shadowImageRecompute;
      removeSourceAndLayer();
    };
  }, [map, isMapLoaded, opts.enabled]);

  // ── Sun / opacity change → compute-only path ──────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded || !opts.enabled) return;
    const fn = (map as unknown as { __shadowImageRecompute?: () => void }).__shadowImageRecompute;
    if (fn) fn();
  }, [map, isMapLoaded, opts.enabled, opts.sunAzimuthDeg, opts.sunAltitudeDeg, opts.opacity]);
}
