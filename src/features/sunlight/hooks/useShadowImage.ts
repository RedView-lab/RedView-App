/**
 * Live cast-shadow overlay backed by a single Mapbox `ImageSource`.
 *
 * This hook replaces the legacy per-tile raster pipeline. The previous
 * design re-fetched ~30 tiles + ran a per-tile padded sweep + PNG encode in
 * the service worker every time the user scrubbed the time slider, because
 * the tile URL embedded `?az=…&alt=…`. Even with caching that was a
 * multi-hundred-millisecond churn, with a visible flicker on the way through
 * Mapbox's tile-fade pipeline.
 *
 * The new model:
 *   • ONE Mapbox ImageSource covering the current viewport bounds.
 *   • A dedicated worker holds the live elevation grid.
 *   • Viewport change → `sample` the grid from the SW DEM cache (~80 ms).
 *   • Time / opacity change → `compute` only (~30 ms total in the worker, no
 *     tile fetch, no source rebuild). The result is a single PNG blob fed to
 *     `ImageSource.updateImage`.
 *
 * Net effect: scrubbing the sun is one frame of latency on the worker plus
 * one image upload — no Mapbox tile cycling.
 */

import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, ImageSource } from 'mapbox-gl';

const SOURCE_ID = 'shadow-image';
const LAYER_ID = 'shadow-image';
const SAMPLE_DEBOUNCE_MS = 180;
const GRID_W = 1024;
const GRID_H = 768;

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

/** Smooth 0→1 ramp around the horizon so shadows don't pop on/off. */
function shadowVisibility(altitudeDeg: number): number {
  const t = Math.max(0, Math.min(1, (altitudeDeg + 2.5) / 6.5));
  return t * t * (3 - 2 * t);
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
  // Promise resolvers keyed by request id so we can await each round-trip.
  const pendingRef = useRef(new Map<number, (a: WorkerAck) => void>());

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

      const bounds = map.getBounds();
      if (!bounds) return;
      const w = bounds.getWest();
      const s = bounds.getSouth();
      const e = bounds.getEast();
      const n = bounds.getNorth();
      const demZoom = chooseDemZoom(map, GRID_W);

      const sampleAck = await post<SampleAck | ErrAck>({
        type: 'sample',
        bounds: [w, s, e, n],
        gridW: GRID_W,
        gridH: GRID_H,
        demZoom,
      });
      if (cancelled) return;
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
        console.warn('[shadow] sample empty: no DEM coverage in viewport', { demZoom, bounds: [w, s, e, n] });
        removeSourceAndLayer();
        return;
      }
      console.log('[shadow] sample ok', { filled: sampleAck.filled, total: sampleAck.total, demZoom });
      sampledRef.current = true;
      await runComputeAndApply([w, s, e, n]);
    };

    const runComputeAndApply = async (b: [number, number, number, number]) => {
      if (cancelled || !sampledRef.current) return;
      const o = optsRef.current;
      if (!o.enabled) return;
      const visibility = shadowVisibility(o.sunAltitudeDeg);
      if (visibility <= 0) {
        // Sun below horizon — leave existing image but make layer invisible.
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
      });
      if (cancelled) return;
      if (ack.type !== 'compute-ok') {
        console.warn('[shadow] compute returned', ack.type);
        return;
      }
      console.log('[shadow] compute ok', { blobSize: ack.blob.size, az: o.sunAzimuthDeg.toFixed(1), alt: o.sunAltitudeDeg.toFixed(1) });

      const url = URL.createObjectURL(ack.blob);
      const coords: [[number, number], [number, number], [number, number], [number, number]] = [
        [b[0], b[3]],
        [b[2], b[3]],
        [b[2], b[1]],
        [b[0], b[1]],
      ];
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
        setTimeout(() => URL.revokeObjectURL(prev), 1500);
      }
    };

    // Schedule a (debounced) full resample after the user stops moving.
    const scheduleSample = () => {
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
      }
      sampleTimerRef.current = (setTimeout(() => {
        sampleTimerRef.current = null;
        runSampleAndCompute();
      }, SAMPLE_DEBOUNCE_MS) as unknown) as number;
    };

    if (!opts.enabled) {
      removeSourceAndLayer();
      return () => { cancelled = true; };
    }

    // Initial run.
    scheduleSample();

    const onMoveEnd = () => scheduleSample();
    const onStyleLoad = () => {
      sampledRef.current = false;
      scheduleSample();
    };
    map.on('moveend', onMoveEnd);
    map.on('style.load', onStyleLoad);

    // Compute-only updater for sun/opacity changes.
    (map as unknown as { __shadowImageRecompute?: () => void }).__shadowImageRecompute = () => {
      if (!sampledRef.current) {
        scheduleSample();
        return;
      }
      const bounds = map.getBounds();
      if (!bounds) return;
      runComputeAndApply([
        bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
      ]);
    };

    return () => {
      cancelled = true;
      map.off('moveend', onMoveEnd);
      map.off('style.load', onStyleLoad);
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
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
