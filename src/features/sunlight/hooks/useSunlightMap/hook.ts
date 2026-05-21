/**
 * useSunlightMap — drives the cumulative-sunshine overlay.
 *
 * Lifecycle is fully independent from `useShadowImage`:
 *   • Own worker, own viewport sample, own exposure cache.
 *   • Own status id (`sunlight-map`) — does NOT clobber the cast-shadow row.
 *
 * Behaviour:
 *   • Sample (debounced) on `moveend` / `zoomend` / `style.load`.
 *   • Compute on date / time / opacity / bands changes — the worker keeps
 *     a per-sample cumulative-minutes buffer, so most time changes only
 *     integrate the new tranche.
 *   • Progress messages from the worker drive the loading status update so
 *     the user sees the integration advancing (just like the shadow dock).
 *   • A new compute request preempts an in-flight one (the worker yields
 *     to its event loop between batches and checks the cancellation token).
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';

import {
  BLOB_REVOKE_DELAY_MS,
  BOUNDS_OVERSHOOT,
  COMPUTE_DEBOUNCE_MS,
  MAX_PARTIAL_SAMPLE_RETRIES,
  MIN_USABLE_SAMPLE_FILL_RATIO,
  PARTIAL_SAMPLE_RETRY_DELAY_MS,
  SAMPLE_DEBOUNCE_MS,
  STEP_MINUTES,
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
  type SmComputeCancelled,
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

type ComputeTerminal = SmComputeAck | SmComputeEmpty | SmComputeCancelled | SmErrAck;

export function useSunlightMap(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseSunlightMapOptions,
  runtimeOptions: UseSunlightMapRuntimeOptions = {},
): void {
  const { statusReporter, registerReload } = runtimeOptions;

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const bandsPayload = useMemo(() => serializeBands(opts.bands), [opts.bands]);
  const bandsHash = useMemo(() => hashBandPayload(bandsPayload), [bandsPayload]);
  const bandsPayloadRef = useRef(bandsPayload);
  bandsPayloadRef.current = bandsPayload;

  const statusReporterRef = useRef(statusReporter);
  statusReporterRef.current = statusReporter;

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastBlobUrlRef = useRef<string | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const computeTimerRef = useRef<number | null>(null);
  const sampledRef = useRef(false);
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
  const partialSampleRetryRef = useRef(0);

  /** Terminal-only resolvers (compute-ok / -cancelled / -empty / error). */
  const computeResolversRef = useRef(new Map<number, (ack: ComputeTerminal) => void>());
  /** Sample resolvers (terminal). */
  const sampleResolversRef = useRef(new Map<number, (ack: SmSampleAck | SmErrAck) => void>());
  /** Active compute id → for routing progress messages. */
  const activeComputeIdRef = useRef<number | null>(null);

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
    statusReporterRef.current?.(status);
  };

  useEffect(() => {
    const worker = new Worker(
      new URL('../../lib/sunlightMapWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SunlightMapWorkerAck>) => {
      const ack = event.data;
      if (ack.type === 'sm-progress') {
        // Progress is non-terminal: route to the active compute's progress
        // hook only if it matches the current request id (drops stale).
        if (activeComputeIdRef.current === ack.id) {
          const totalSteps = Math.max(1, ack.totalSteps);
          const pct = Math.round((ack.stepsDone / totalSteps) * 70) + 22; // 22→92
          publishStatus(sunlightMapLoadingStatus(pct, `Ensoleillement ${ack.stepsDone}/${totalSteps}`));
        }
        return;
      }
      if (ack.type === 'sm-sample-ok' || ack.type === 'sm-error') {
        const sampleResolver = sampleResolversRef.current.get(ack.id);
        if (sampleResolver) {
          sampleResolversRef.current.delete(ack.id);
          sampleResolver(ack as SmSampleAck | SmErrAck);
          return;
        }
        // Fall through if not a sample resolver (sm-error can resolve a compute too).
      }
      const computeResolver = computeResolversRef.current.get(ack.id);
      if (computeResolver) {
        computeResolversRef.current.delete(ack.id);
        computeResolver(ack as ComputeTerminal);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      computeResolversRef.current.clear();
      sampleResolversRef.current.clear();
      activeComputeIdRef.current = null;
      if (lastBlobUrlRef.current) {
        URL.revokeObjectURL(lastBlobUrlRef.current);
        lastBlobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    let cancelled = false;

    const postSample = (message: object): Promise<SmSampleAck | SmErrAck> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error('worker not ready'));
      const id = ++reqIdRef.current;
      return new Promise<SmSampleAck | SmErrAck>((resolve) => {
        sampleResolversRef.current.set(id, resolve);
        worker.postMessage({ ...message, id });
      });
    };

    const postCompute = (message: object): Promise<ComputeTerminal> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error('worker not ready'));
      const id = ++reqIdRef.current;
      activeComputeIdRef.current = id;
      return new Promise<ComputeTerminal>((resolve) => {
        computeResolversRef.current.set(id, resolve);
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
        activeComputeIdRef.current = null;
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
      const currentMinutes = parseTimeToMinutes(current.time);

      publishStatus(sunlightMapLoadingStatus(20, 'Calcul en cours'));

      const ack = await postCompute({
        type: 'sm-compute',
        isoDate: current.date,
        currentMinutes,
        stepMinutes: STEP_MINUTES,
        centerLat,
        centerLon,
        bands: bandsPayloadRef.current,
        opacity: Math.max(0, Math.min(1, current.opacity)),
        quality: current.timeScrubbing ? 'preview' : 'full',
      });

      if (cancelled) return;
      if (job.sampleGen !== sampleGenRef.current) return;
      if (job.computeSeq !== computeSeqRef.current) return;

      if (ack.type === 'sm-compute-cancelled') {
        // Preempted by a newer compute. Don't update the layer; the new
        // compute will publish status when it lands.
        return;
      }
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

      publishStatus(sunlightMapLoadingStatus(94, 'Application'));
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

      publishStatus(sunlightMapReadyStatus(formatReadyDetail(currentMinutes)));
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
        // Replace any queued job; only the latest matters.
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

      publishStatus(sunlightMapLoadingStatus(18, 'Echantillonnage du relief'));

      const sampleAck = await postSample({
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
          publishStatus(sunlightMapLoadingStatus(16, `Relief partiel (${Math.round(fillRatio * 100)}%)`));
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
        20,
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
      if (sampledRef.current && sampledBoundsRef.current) enqueueCompute();
      else scheduleSample();
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
      activeComputeIdRef.current = null;
      scheduleSampleRef.current = null;
      requestResampleRef.current = null;
      scheduleComputeRef.current = null;
      removeOverlay(true);
      publishStatus(null);
    };
    // statusReporter intentionally excluded — captured via ref so updates
    // don't tear down the entire pipeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMapLoaded, map]);

  // Re-trigger compute on time/date/bands/opacity/scrub changes.
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
  }, [
    map,
    isMapLoaded,
    opts.enabled,
    opts.date,
    opts.time,
    opts.opacity,
    opts.timeScrubbing,
    bandsHash,
  ]);

  // Live opacity updates without re-running the worker.
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

function formatReadyDetail(currentMinutes: number): string {
  const hh = Math.floor(currentMinutes / 60).toString().padStart(2, '0');
  const mm = (currentMinutes % 60).toString().padStart(2, '0');
  return `Cumul jusqu'a ${hh}:${mm}`;
}
