/**
 * Live cast-shadow overlay backed by a single Mapbox `ImageSource`.
 *
 * v4 — Apr 21 2026 — responsiveness/stability pass.
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
 *  • Resample is scheduled on `moveend`, `zoomend`, `rotateend` and
 *    `pitchend`; debounce dropped from 180 ms → 80 ms (still long enough
 *    to absorb a single moveend storm but no longer perceptible).
 *  • Worker requests are strictly serialized: at most one inflight + one
 *    pending. Intermediate requests collapse into the pending slot, so
 *    a long zoom storm produces O(1) work instead of one job per event.
 *  • User opacity no longer triggers worker compute. The worker now renders
 *    geometry-only shadow content while the final intensity is applied via
 *    the raster layer's `raster-opacity`, making slider drags instant.
 *  • Toggle-off now hides the layer without discarding the sampled DEM grid,
 *    so a rapid re-enable can reuse warm state instead of restarting cold.
 */

import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, ImageSource } from 'mapbox-gl';
import {
  createOverlayStatus,
} from '@/features/map3d/overlayStatus';
import type {
  BoundsTuple,
  ComputeAck,
  ComputeEmpty,
  ComputeJob,
  ErrAck,
  SampleAck,
  UseShadowImageOptions,
  UseShadowImageRuntimeOptions,
  WorkerAck,
} from './useShadowImageShared';
import {
  BLOB_REVOKE_DELAY_MS,
  BOUNDS_OVERSHOOT,
  chooseDemZoom,
  chooseGridSize,
  effectiveOverlayOpacity,
  LAYER_ID,
  preloadBlobUrl,
  SAMPLE_DEBOUNCE_MS,
  shadowVisibility,
  SOURCE_ID,
  withOvershoot,
} from './useShadowImageShared';

export function useShadowImage(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseShadowImageOptions,
  runtimeOptions: UseShadowImageRuntimeOptions = {},
): void {
  const { statusReporter, registerReload } = runtimeOptions;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastBlobUrlRef = useRef<string | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const sunRecomputeFrameRef = useRef<number | null>(null);
  const sampledRef = useRef(false);
  /**
   * Bounds last successfully sampled (with overshoot already applied).
   * Used as the geographic anchor for the displayed image until the next
   * resample completes.
   */
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
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
  // Compute-only updates are also latest-wins: one inflight worker compute,
  // plus one pending slot overwritten by the newest sun/time state.
  const computeSeqRef = useRef(0);
  const computeInflightRef = useRef(false);
  const pendingComputeRef = useRef<ComputeJob | null>(null);
  const scheduleSampleRef = useRef<(() => void) | null>(null);
  const requestResampleRef = useRef<(() => void) | null>(null);
  const recomputeRef = useRef<(() => void) | null>(null);
  const setLayerOpacityRef = useRef<((opacity: number) => void) | null>(null);

  const publishStatus = (status: ReturnType<typeof createOverlayStatus> | null) => {
    statusReporter?.(status);
  };

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
      if (sunRecomputeFrameRef.current !== null) {
        cancelAnimationFrame(sunRecomputeFrameRef.current);
        sunRecomputeFrameRef.current = null;
      }
    };
  }, []);

  // ── Source / layer ensure, resample, compute and visibility ───────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const setLayerOpacity = (opacity: number) => {
      if (!map.getLayer(LAYER_ID)) return;
      try {
        map.setPaintProperty(LAYER_ID, 'raster-opacity', Math.max(0, Math.min(1, opacity)));
      } catch {
        /* no-op */
      }
    };

    const applyVisibleOpacity = () => {
      const o = optsRef.current;
      setLayerOpacity(effectiveOverlayOpacity(o.enabled, o.opacity, o.sunAltitudeDeg));
    };

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
              'raster-opacity': effectiveOverlayOpacity(
                optsRef.current.enabled,
                optsRef.current.opacity,
                optsRef.current.sunAltitudeDeg,
              ),
              'raster-fade-duration': 0,
              'raster-resampling': 'linear',
            },
          } as never);
        } catch (err) {
          console.warn('[shadow] addLayer failed', err);
        }
      }
    };

    const removeSourceAndLayer = (clearSample: boolean) => {
      try { if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID); } catch { /* */ }
      try { if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID); } catch { /* */ }
      if (clearSample) {
        sampledRef.current = false;
        sampledBoundsRef.current = null;
        computeSeqRef.current++;
        pendingComputeRef.current = null;
      }
    };

    let cancelled = false;
    setLayerOpacityRef.current = setLayerOpacity;

    const post = <T extends WorkerAck>(msg: object): Promise<T> => {
      const w = workerRef.current;
      if (!w) return Promise.reject(new Error('worker not ready'));
      const id = ++reqIdRef.current;
      return new Promise<T>((resolve) => {
        pendingRef.current.set(id, resolve as (a: WorkerAck) => void);
        w.postMessage({ ...msg, id });
      });
    };

    const runComputeAndApply = async (job: ComputeJob) => {
      if (cancelled || !sampledRef.current) return;
      if (job.sampleGen !== sampleGenRef.current) return;
      if (job.computeSeq !== computeSeqRef.current) return;

      publishStatus(createOverlayStatus({
        id: 'shadow',
        label: 'Ombres',
        state: 'loading',
        progress: job.quality === 'preview' ? 62 : 68,
        detail: job.quality === 'preview' ? 'Aperçu des ombres' : 'Calcul des ombres',
        reloadable: true,
      }));

      const o = optsRef.current;
      const shadowStrength = shadowVisibility(o.sunAltitudeDeg);
      if (!o.enabled || (o.sunAltitudeDeg >= 0 && o.opacity <= 0) || shadowStrength <= 0) {
        setLayerOpacity(0);
        return;
      }

      const ack = await post<ComputeAck | ComputeEmpty | ErrAck>({
        type: 'compute',
        sunAzDeg: o.sunAzimuthDeg,
        sunAltDeg: o.sunAltitudeDeg,
        shadowStrength,
        nightFloor: 0,
        quality: job.quality,
      });
      if (cancelled) return;
      if (job.sampleGen !== sampleGenRef.current) return;
      if (job.computeSeq !== computeSeqRef.current) return;
      if (ack.type === 'error') {
        console.warn('[shadow] compute failed', ack.message);
        publishStatus(createOverlayStatus({
          id: 'shadow',
          label: 'Ombres',
          state: 'error',
          progress: 0,
          detail: ack.message,
          reloadable: true,
        }));
        return;
      }
      if (ack.type !== 'compute-ok') {
        setLayerOpacity(0);
        publishStatus(createOverlayStatus({
          id: 'shadow',
          label: 'Ombres',
          state: 'error',
          progress: 0,
          detail: 'Calcul vide',
          reloadable: true,
        }));
        return;
      }

      const url = URL.createObjectURL(ack.blob);
      const coords: [[number, number], [number, number], [number, number], [number, number]] = [
        [job.bounds[0], job.bounds[3]],
        [job.bounds[2], job.bounds[3]],
        [job.bounds[2], job.bounds[1]],
        [job.bounds[0], job.bounds[1]],
      ];

      publishStatus(createOverlayStatus({
        id: 'shadow',
        label: 'Ombres',
        state: 'loading',
        progress: 86,
        detail: 'Assemblage',
        reloadable: true,
      }));

      await preloadBlobUrl(url);
      if (cancelled || job.sampleGen !== sampleGenRef.current || job.computeSeq !== computeSeqRef.current) {
        URL.revokeObjectURL(url);
        return;
      }

      ensureSourceAndLayer(url, coords);
      const src = map.getSource(SOURCE_ID) as ImageSource | undefined;
      if (src) {
        try {
          src.updateImage({ url, coordinates: coords });
          applyVisibleOpacity();
        } catch (err) {
          console.warn('[shadow] updateImage failed', err);
        }
      }

      const prev = lastBlobUrlRef.current;
      lastBlobUrlRef.current = url;
      if (prev) {
        setTimeout(() => URL.revokeObjectURL(prev), BLOB_REVOKE_DELAY_MS);
      }

      publishStatus(createOverlayStatus({
        id: 'shadow',
        label: 'Ombres',
        state: 'ready',
        progress: 100,
        detail: 'Overlay prêt',
        reloadable: true,
      }));
    };

    const processComputeQueue = async (initialJob: ComputeJob) => {
      if (computeInflightRef.current) {
        pendingComputeRef.current = initialJob;
        return;
      }

      computeInflightRef.current = true;
      let job: ComputeJob | null = initialJob;
      try {
        while (job && !cancelled) {
          pendingComputeRef.current = null;
          await runComputeAndApply(job);
          job = pendingComputeRef.current;
        }
      } finally {
        computeInflightRef.current = false;
      }
    };

    const canMutateStyle = () => {
      if (cancelled) return false;
      try {
        return map.isStyleLoaded() && Boolean(map.getStyle());
      } catch {
        return false;
      }
    };

    const requestCompute = (bounds: BoundsTuple, sampleGen: number) => {
      const job: ComputeJob = {
        bounds,
        sampleGen,
        computeSeq: ++computeSeqRef.current,
        quality: optsRef.current.timeScrubbing ? 'preview' : 'full',
      };
      if (computeInflightRef.current) {
        pendingComputeRef.current = job;
        return;
      }
      void processComputeQueue(job).catch((err) => console.warn('[shadow] compute queue error', err));
    };

    const runSampleAndCompute = async () => {
      if (!canMutateStyle()) return;
      const o = optsRef.current;
      if (!o.enabled) return;

      publishStatus(createOverlayStatus({
        id: 'shadow',
        label: 'Ombres',
        state: 'loading',
        progress: 12,
        detail: 'Préparation',
        reloadable: true,
      }));

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

      publishStatus(createOverlayStatus({
        id: 'shadow',
        label: 'Ombres',
        state: 'loading',
        progress: 28,
        detail: 'Échantillonnage du relief',
        reloadable: true,
      }));

      const sampleAck = await post<SampleAck | ErrAck>({
        type: 'sample',
        bounds: sampledBounds,
        gridW,
        gridH,
        demZoom,
      });
      if (cancelled || myGen !== sampleGenRef.current) return;
      const hasPreviousSample = sampledRef.current && sampledBoundsRef.current;

      if (sampleAck.type === 'error') {
        console.warn('[shadow] sample failed', sampleAck.message);
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(createOverlayStatus({
            id: 'shadow',
            label: 'Ombres',
            state: 'ready',
            progress: 100,
            detail: 'Dernier relief valide conservé',
            reloadable: true,
          }));
          return;
        }
        publishStatus(createOverlayStatus({
          id: 'shadow',
          label: 'Ombres',
          state: 'error',
          progress: 0,
          detail: sampleAck.message,
          reloadable: true,
        }));
        return;
      }
      if (sampleAck.tooMany) {
        console.info('[shadow] sample skipped: viewport spans too many DEM tiles');
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(createOverlayStatus({
            id: 'shadow',
            label: 'Ombres',
            state: 'ready',
            progress: 100,
            detail: 'Dernier relief valide conservé',
            reloadable: true,
          }));
          return;
        }
        removeSourceAndLayer(true);
        setLayerOpacity(0);
        publishStatus(null);
        return;
      }
      if (sampleAck.filled === 0) {
        console.warn('[shadow] sample empty: no DEM coverage in viewport', { demZoom, bounds: sampledBounds });
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(createOverlayStatus({
            id: 'shadow',
            label: 'Ombres',
            state: 'ready',
            progress: 100,
            detail: 'Dernier relief valide conservé',
            reloadable: true,
          }));
          return;
        }
        removeSourceAndLayer(true);
        setLayerOpacity(0);
        publishStatus(createOverlayStatus({
          id: 'shadow',
          label: 'Ombres',
          state: 'error',
          progress: 0,
          detail: 'Aucune donnée terrain',
          reloadable: true,
        }));
        return;
      }
      sampledRef.current = true;
      sampledBoundsRef.current = sampledBounds;
      publishStatus(createOverlayStatus({
        id: 'shadow',
        label: 'Ombres',
        state: 'loading',
        progress: 58,
        detail: sampleAck.downgraded
          ? `Relief capturé (DEM z${sampleAck.effectiveZoom ?? demZoom})`
          : 'Relief capturé',
        reloadable: true,
      }));
      requestCompute(sampledBounds, myGen);
    };

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

    const scheduleSample = () => {
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
      }
      sampleTimerRef.current = (setTimeout(() => {
        sampleTimerRef.current = null;
        requestResample();
      }, SAMPLE_DEBOUNCE_MS) as unknown) as number;
    };

    scheduleSampleRef.current = scheduleSample;
    requestResampleRef.current = requestResample;
    recomputeRef.current = () => {
      const bounds = sampledBoundsRef.current;
      if (!sampledRef.current || !bounds) {
        scheduleSample();
        return;
      }
      requestCompute(bounds, sampleGenRef.current);
    };

    if (optsRef.current.enabled) {
      if (sampledRef.current && sampledBoundsRef.current) {
        requestCompute(sampledBoundsRef.current, sampleGenRef.current);
      } else {
        scheduleSample();
      }
    } else {
      setLayerOpacity(0);
      publishStatus(null);
    }

    const onMoveEnd = () => scheduleSample();
    const onZoomEnd = () => scheduleSample();
    const onRotateEnd = () => scheduleSample();
    const onPitchEnd = () => scheduleSample();
    const onStyleLoad = () => {
      removeSourceAndLayer(false);
      if (!optsRef.current.enabled) return;
      if (sampledRef.current && sampledBoundsRef.current) {
        requestCompute(sampledBoundsRef.current, sampleGenRef.current);
      } else {
        scheduleSample();
      }
    };
    map.on('moveend', onMoveEnd);
    map.on('zoomend', onZoomEnd);
    map.on('rotateend', onRotateEnd);
    map.on('pitchend', onPitchEnd);
    map.on('style.load', onStyleLoad);

    return () => {
      cancelled = true;
      map.off('moveend', onMoveEnd);
      map.off('zoomend', onZoomEnd);
      map.off('rotateend', onRotateEnd);
      map.off('pitchend', onPitchEnd);
      map.off('style.load', onStyleLoad);
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      if (sunRecomputeFrameRef.current !== null) {
        cancelAnimationFrame(sunRecomputeFrameRef.current);
        sunRecomputeFrameRef.current = null;
      }
      inflightRef.current = false;
      pendingResampleRef.current = false;
      computeInflightRef.current = false;
      pendingComputeRef.current = null;
      scheduleSampleRef.current = null;
      requestResampleRef.current = null;
      recomputeRef.current = null;
      setLayerOpacityRef.current = null;
      removeSourceAndLayer(true);
      publishStatus(null);
    };
  }, [isMapLoaded, map, statusReporter]);

  useEffect(() => {
    if (!registerReload) return;
    if (!map || !isMapLoaded || !opts.enabled) {
      registerReload(null);
      return;
    }
    registerReload(() => {
      if (requestResampleRef.current) {
        requestResampleRef.current();
        return;
      }
      scheduleSampleRef.current?.();
    });
    return () => {
      registerReload(null);
    };
  }, [isMapLoaded, map, opts.enabled, registerReload]);

  // ── Toggle / visibility changes ────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const setLayerOpacity = setLayerOpacityRef.current;
    if (setLayerOpacity) {
      setLayerOpacity(effectiveOverlayOpacity(opts.enabled, opts.opacity, opts.sunAltitudeDeg));
    }
    if (!opts.enabled) {
      publishStatus(null);
      return;
    }
    if (sampledRef.current && sampledBoundsRef.current) {
      recomputeRef.current?.();
    } else {
      scheduleSampleRef.current?.();
    }
  }, [isMapLoaded, map, opts.enabled, statusReporter]);

  // Opacity scrubs stay on the Mapbox paint property and never hit the worker.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const setLayerOpacity = setLayerOpacityRef.current;
    if (!setLayerOpacity) return;
    setLayerOpacity(effectiveOverlayOpacity(opts.enabled, opts.opacity, opts.sunAltitudeDeg));
  }, [map, isMapLoaded, opts.enabled, opts.opacity, opts.sunAltitudeDeg]);

  // Sun/time changes reuse the sampled grid and coalesce to the latest state.
  useEffect(() => {
    if (!map || !isMapLoaded || !opts.enabled) return;
    if (sunRecomputeFrameRef.current !== null) {
      cancelAnimationFrame(sunRecomputeFrameRef.current);
    }
    sunRecomputeFrameRef.current = requestAnimationFrame(() => {
      sunRecomputeFrameRef.current = null;
      recomputeRef.current?.();
    });

    return () => {
      if (sunRecomputeFrameRef.current !== null) {
        cancelAnimationFrame(sunRecomputeFrameRef.current);
        sunRecomputeFrameRef.current = null;
      }
    };
  }, [map, isMapLoaded, opts.sunAzimuthDeg, opts.sunAltitudeDeg, opts.timeScrubbing]);
}
