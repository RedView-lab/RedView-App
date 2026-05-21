/**
 * useSunlightMap — drives the cumulative-sunshine overlay.
 *
 * Architecture parallels `useShadowImage`:
 *   • A dedicated Web Worker owns the elevation grid + cumulative-exposure
 *     state for the current viewport. Each request is identified by an
 *     incrementing `id` so out-of-order acks can be discarded.
 *   • Sampling is debounced and replays after viewport changes only.
 *   • Compute runs whenever date/time/bands/opacity change. A monotonically
 *     advancing time within the same calendar day takes the worker's
 *     incremental fast path (no re-sweep of past steps).
 *   • Time scrubbing (`timeScrubbing: true`) switches the worker to the
 *     `preview` quality tier so the slider stays responsive.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';

import {
  BLOB_REVOKE_DELAY_MS,
  BOUNDS_OVERSHOOT,
  COMPUTE_DEBOUNCE_MS,
  FULL_STEP_MINUTES,
  MAX_PARTIAL_SAMPLE_RETRIES,
  MIN_USABLE_SAMPLE_FILL_RATIO,
  PARTIAL_SAMPLE_RETRY_DELAY_MS,
  PREVIEW_STEP_MINUTES,
  SAMPLE_DEBOUNCE_MS,
  STYLE_PREPARATION_RETRY_DELAY_MS,
  SUNLIGHT_MAP_LAYER_ID,
  SUNLIGHT_MAP_SOURCE_ID,
  canMutateMapStyle,
  chooseDemZoom,
  chooseGridSize,
  effectiveLayerOpacity,
  ensureSunlightMapSourceAndLayer,
  hashBandPayload,
  parseTimeToMinutes,
  preloadBlobUrl,
  removeSunlightMapSourceAndLayer,
  serializeBands,
  setSunlightMapLayerOpacity,
  withOvershoot,
  type BoundsTuple,
  type ComputeJob,
  type SmComputeAck,
  type SmComputeEmpty,
  type SmErrAck,
  type SmSampleAck,
  type SunlightMapWorkerAck,
  type UseSunlightMapOptions,
  type UseSunlightMapRuntimeOptions,
} from './shared';
import {
  sunlightMapErrorStatus,
  sunlightMapLoadingStatus,
  sunlightMapReadyStatus,
} from './status';

export function useSunlightMap(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseSunlightMapOptions,
  runtimeOptions: UseSunlightMapRuntimeOptions = {},
): void {
  const { statusReporter, registerReload } = runtimeOptions;

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Memoize the serialized bands so the worker only re-runs when the user
  // actually edits a band (not on unrelated re-renders).
  const bandsPayload = useMemo(() => serializeBands(opts.bands), [opts.bands]);
  const bandsHash = useMemo(() => hashBandPayload(bandsPayload), [bandsPayload]);
  const bandsPayloadRef = useRef(bandsPayload);
  bandsPayloadRef.current = bandsPayload;

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastBlobUrlRef = useRef<string | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const computeTimerRef = useRef<number | null>(null);
  const sampledRef = useRef(false);
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
  const partialSampleRetryRef = useRef(0);
  const pendingRef = useRef(new Map<number, (ack: SunlightMapWorkerAck) => void>());

  const sampleGenRef = useRef(0);
  const inflightSampleRef = useRef(false);
  const pendingResampleRef = useRef(false);
  const computeSeqRef = useRef(0);
  const computeInflightRef = useRef(false);
  const pendingComputeRef = useRef<ComputeJob | null>(null);

  const scheduleSampleRef = useRef<(() => void) | null>(null);
  const requestResampleRef = useRef<(() => void) | null>(null);
  const scheduleComputeRef = useRef<(() => void) | null>(null);

  const publishStatus = (status: ReturnType<typeof sunlightMapLoadingStatus> | null) => {
    statusReporter?.(status);
  };

  useEffect(() => {
    const worker = new Worker(
      new URL('../../lib/sunlightMapWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SunlightMapWorkerAck>) => {
      const resolver = pendingRef.current.get(event.data.id);
      if (resolver) {
        pendingRef.current.delete(event.data.id);
        resolver(event.data);
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

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    let cancelled = false;

    const post = <T extends SunlightMapWorkerAck>(message: object): Promise<T> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error('worker not ready'));
      const id = ++reqIdRef.current;
      return new Promise<T>((resolve) => {
        pendingRef.current.set(id, resolve as (ack: SunlightMapWorkerAck) => void);
        worker.postMessage({ ...message, id });
      });
    };

    const applyVisibleOpacity = () => {
      const current = optsRef.current;
      setSunlightMapLayerOpacity(map, effectiveLayerOpacity(current.enabled, current.opacity));
    };

    const removeOverlay = (clearSample: boolean) => {
      removeSunlightMapSourceAndLayer(map);
      if (clearSample) {
        sampledRef.current = false;
        sampledBoundsRef.current = null;
        computeSeqRef.current++;
        pendingComputeRef.current = null;
      }
    };

    const runComputeAndApply = async (job: ComputeJob) => {
      if (cancelled || !sampledRef.current) return;
      if (job.sampleGen !== sampleGenRef.current) return;
      if (job.computeSeq !== computeSeqRef.current) return;

      const current = optsRef.current;
      if (!current.enabled) {
        setSunlightMapLayerOpacity(map, 0);
        return;
      }

      const bounds = map.getBounds();
      if (!bounds) return;
      const centerLat = (bounds.getNorth() + bounds.getSouth()) / 2;
      const centerLon = (bounds.getEast() + bounds.getWest()) / 2;

      publishStatus(sunlightMapLoadingStatus(
        job.quality === 'preview' ? 55 : 65,
        job.quality === 'preview' ? 'Apercu de l\'ensoleillement' : 'Cumul d\'exposition',
      ));

      const ack = await post<SmComputeAck | SmComputeEmpty | SmErrAck>({
        type: 'sm-compute',
        isoDate: current.date,
        currentMinutes: parseTimeToMinutes(current.time),
        stepMinutes: job.quality === 'preview' ? PREVIEW_STEP_MINUTES : FULL_STEP_MINUTES,
        centerLat,
        centerLon,
        bands: bandsPayloadRef.current,
        opacity: Math.max(0, Math.min(1, current.opacity)),
        quality: job.quality,
      });

      if (cancelled) return;
      if (job.sampleGen !== sampleGenRef.current) return;
      if (job.computeSeq !== computeSeqRef.current) return;

      if (ack.type === 'sm-error') {
        console.warn('[sunlight-map] compute failed', ack.message);
        publishStatus(sunlightMapErrorStatus(ack.message));
        return;
      }
      if (ack.type !== 'sm-compute-ok') {
        setSunlightMapLayerOpacity(map, 0);
        publishStatus(sunlightMapErrorStatus('Calcul vide'));
        return;
      }

      const url = URL.createObjectURL(ack.blob);
      const coords: [[number, number], [number, number], [number, number], [number, number]] = [
        [job.bounds[0], job.bounds[3]],
        [job.bounds[2], job.bounds[3]],
        [job.bounds[2], job.bounds[1]],
        [job.bounds[0], job.bounds[1]],
      ];

      publishStatus(sunlightMapLoadingStatus(88, 'Assemblage'));
      await preloadBlobUrl(url);
      if (cancelled || job.sampleGen !== sampleGenRef.current || job.computeSeq !== computeSeqRef.current) {
        URL.revokeObjectURL(url);
        return;
      }

      ensureSunlightMapSourceAndLayer(map, url, coords, effectiveLayerOpacity(current.enabled, current.opacity));
      const source = map.getSource(SUNLIGHT_MAP_SOURCE_ID) as ImageSource | undefined;
      if (!source || !map.getLayer(SUNLIGHT_MAP_LAYER_ID)) {
        URL.revokeObjectURL(url);
        setSunlightMapLayerOpacity(map, 0);
        publishStatus(sunlightMapErrorStatus("Couche d'ensoleillement absente"));
        return;
      }
      try {
        source.updateImage({ url, coordinates: coords });
        applyVisibleOpacity();
      } catch (err) {
        console.warn('[sunlight-map] updateImage failed', err);
        URL.revokeObjectURL(url);
        setSunlightMapLayerOpacity(map, 0);
        publishStatus(sunlightMapErrorStatus("Application de l'overlay impossible"));
        return;
      }

      const previous = lastBlobUrlRef.current;
      lastBlobUrlRef.current = url;
      if (previous) {
        setTimeout(() => URL.revokeObjectURL(previous), BLOB_REVOKE_DELAY_MS);
      }

      publishStatus(sunlightMapReadyStatus('Overlay pret'));
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

    const enqueueCompute = () => {
      const bounds = sampledBoundsRef.current;
      if (!sampledRef.current || !bounds) return;
      const current = optsRef.current;
      if (!current.enabled) return;
      const job: ComputeJob = {
        bounds,
        sampleGen: sampleGenRef.current,
        computeSeq: ++computeSeqRef.current,
        quality: current.timeScrubbing ? 'preview' : 'full',
      };
      if (computeInflightRef.current) {
        pendingComputeRef.current = job;
        return;
      }
      void processComputeQueue(job).catch((err) => console.warn('[sunlight-map] compute queue error', err));
    };

    const scheduleCompute = () => {
      if (computeTimerRef.current !== null) clearTimeout(computeTimerRef.current);
      computeTimerRef.current = (setTimeout(() => {
        computeTimerRef.current = null;
        enqueueCompute();
      }, COMPUTE_DEBOUNCE_MS) as unknown) as number;
    };
    scheduleComputeRef.current = scheduleCompute;

    const requestResample = () => {
      if (inflightSampleRef.current) {
        pendingResampleRef.current = true;
        return;
      }
      inflightSampleRef.current = true;
      runSampleAndCompute()
        .catch((err) => console.warn('[sunlight-map] resample error', err))
        .finally(() => {
          inflightSampleRef.current = false;
          if (pendingResampleRef.current && !cancelled && optsRef.current.enabled) {
            pendingResampleRef.current = false;
            requestResample();
          }
        });
    };
    requestResampleRef.current = requestResample;

    const runSampleAndCompute = async () => {
      const current = optsRef.current;
      if (!current.enabled) return;
      if (!canMutateMapStyle(map)) {
        publishStatus(sunlightMapLoadingStatus(6, 'Style en preparation'));
        if (sampleTimerRef.current === null) {
          sampleTimerRef.current = (setTimeout(() => {
            sampleTimerRef.current = null;
            if (!cancelled && optsRef.current.enabled) requestResample();
          }, STYLE_PREPARATION_RETRY_DELAY_MS) as unknown) as number;
        }
        return;
      }

      publishStatus(sunlightMapLoadingStatus(14, 'Preparation'));

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

      publishStatus(sunlightMapLoadingStatus(30, 'Echantillonnage du relief'));

      const sampleAck = await post<SmSampleAck | SmErrAck>({
        type: 'sm-sample',
        bounds: sampledBounds,
        gridW,
        gridH,
        demZoom,
      });
      if (cancelled || myGen !== sampleGenRef.current) return;

      const hasPreviousSample = sampledRef.current && sampledBoundsRef.current;

      if (sampleAck.type === 'sm-error') {
        console.warn('[sunlight-map] sample failed', sampleAck.message);
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(sunlightMapReadyStatus('Dernier relief valide conserve'));
          return;
        }
        publishStatus(sunlightMapErrorStatus(sampleAck.message));
        return;
      }
      if (sampleAck.tooMany) {
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(sunlightMapReadyStatus('Dernier relief valide conserve'));
          return;
        }
        removeOverlay(true);
        setSunlightMapLayerOpacity(map, 0);
        publishStatus(null);
        return;
      }
      if (sampleAck.filled === 0) {
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(sunlightMapReadyStatus('Dernier relief valide conserve'));
          return;
        }
        removeOverlay(true);
        setSunlightMapLayerOpacity(map, 0);
        publishStatus(sunlightMapErrorStatus('Aucune donnee terrain'));
        return;
      }

      const fillRatio = sampleAck.total > 0 ? sampleAck.filled / sampleAck.total : 0;
      if (fillRatio < MIN_USABLE_SAMPLE_FILL_RATIO) {
        partialSampleRetryRef.current++;
        if (sampleTimerRef.current !== null) clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = (setTimeout(() => {
          sampleTimerRef.current = null;
          if (!cancelled && optsRef.current.enabled) requestResample();
        }, PARTIAL_SAMPLE_RETRY_DELAY_MS) as unknown) as number;

        if (partialSampleRetryRef.current <= MAX_PARTIAL_SAMPLE_RETRIES) {
          if (hasPreviousSample) applyVisibleOpacity();
          else setSunlightMapLayerOpacity(map, 0);
          publishStatus(sunlightMapLoadingStatus(50, `Relief partiel (${Math.round(fillRatio * 100)}%)`));
          return;
        }

        if (!hasPreviousSample) {
          removeOverlay(true);
          setSunlightMapLayerOpacity(map, 0);
          publishStatus(sunlightMapErrorStatus('Relief incomplet'));
          return;
        }
        applyVisibleOpacity();
        publishStatus(sunlightMapReadyStatus('Dernier relief valide conserve'));
        return;
      }

      partialSampleRetryRef.current = 0;
      sampledRef.current = true;
      sampledBoundsRef.current = sampledBounds;
      publishStatus(sunlightMapLoadingStatus(
        58,
        sampleAck.downgraded ? `Relief capture (DEM z${sampleAck.effectiveZoom})` : 'Relief capture',
      ));
      enqueueCompute();
    };

    const scheduleSample = () => {
      if (sampleTimerRef.current !== null) clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = (setTimeout(() => {
        sampleTimerRef.current = null;
        requestResample();
      }, SAMPLE_DEBOUNCE_MS) as unknown) as number;
    };
    scheduleSampleRef.current = scheduleSample;

    if (optsRef.current.enabled) {
      if (sampledRef.current && sampledBoundsRef.current) {
        enqueueCompute();
      } else {
        scheduleSample();
      }
    } else {
      setSunlightMapLayerOpacity(map, 0);
      publishStatus(null);
    }

    const onMoveEnd = () => scheduleSample();
    const onZoomEnd = () => scheduleSample();
    const onStyleLoad = () => {
      removeOverlay(false);
      if (!optsRef.current.enabled) return;
      if (sampledRef.current && sampledBoundsRef.current) enqueueCompute();
      else scheduleSample();
    };
    map.on('moveend', onMoveEnd);
    map.on('zoomend', onZoomEnd);
    map.on('style.load', onStyleLoad);

    return () => {
      cancelled = true;
      map.off('moveend', onMoveEnd);
      map.off('zoomend', onZoomEnd);
      map.off('style.load', onStyleLoad);
      if (sampleTimerRef.current !== null) {
        clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      if (computeTimerRef.current !== null) {
        clearTimeout(computeTimerRef.current);
        computeTimerRef.current = null;
      }
      inflightSampleRef.current = false;
      pendingResampleRef.current = false;
      computeInflightRef.current = false;
      pendingComputeRef.current = null;
      scheduleSampleRef.current = null;
      requestResampleRef.current = null;
      scheduleComputeRef.current = null;
      removeOverlay(true);
      publishStatus(null);
    };
  }, [isMapLoaded, map, statusReporter]);

  // Re-trigger sample on (enabled → true) transitions; recompute on
  // date/time/bands/opacity changes (cheap if grid is cached).
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!opts.enabled) {
      setSunlightMapLayerOpacity(map, 0);
      publishStatus(null);
      return;
    }
    if (sampledRef.current && sampledBoundsRef.current) {
      scheduleComputeRef.current?.();
    } else {
      scheduleSampleRef.current?.();
    }
    // bandsHash captured so external opt.bands edits trigger a recompute.
  }, [
    map,
    isMapLoaded,
    opts.enabled,
    opts.date,
    opts.time,
    opts.opacity,
    opts.timeScrubbing,
    bandsHash,
    statusReporter,
  ]);

  // Live opacity updates without recomputing the worker overlay.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    setSunlightMapLayerOpacity(map, effectiveLayerOpacity(opts.enabled, opts.opacity));
  }, [map, isMapLoaded, opts.enabled, opts.opacity]);

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
}
