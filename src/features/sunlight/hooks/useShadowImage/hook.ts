import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, ImageSource } from 'mapbox-gl';
import type { OverlayStatusSnapshot } from '@/features/map3d';
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
} from '../useShadowImageShared';
import {
  BLOB_REVOKE_DELAY_MS,
  BOUNDS_OVERSHOOT,
  canMutateShadowStyle,
  chooseDemZoom,
  chooseGridSize,
  computeNightFloor,
  ensureShadowSourceAndLayer,
  effectiveOverlayOpacity,
  LAYER_ID,
  preloadBlobUrl,
  removeShadowSourceAndLayer,
  SAMPLE_DEBOUNCE_MS,
  setShadowLayerOpacity,
  shadowVisibility,
  SOURCE_ID,
  withOvershoot,
} from '../useShadowImageShared';
import {
  MAX_PARTIAL_SAMPLE_RETRIES,
  MIN_USABLE_SAMPLE_FILL_RATIO,
  MIN_VISIBLE_SHADOW_ALPHA_RATIO,
  PARTIAL_SAMPLE_RETRY_DELAY_MS,
  STYLE_PREPARATION_RETRY_DELAY_MS,
} from './constants';
import {
  shadowErrorStatus,
  shadowLoadingStatus,
  shadowReadyStatus,
} from './status';

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
  const partialSampleRetryCountRef = useRef(0);
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
  const pendingRef = useRef(new Map<number, (ack: WorkerAck) => void>());

  const sampleGenRef = useRef(0);
  const inflightRef = useRef(false);
  const pendingResampleRef = useRef(false);
  const computeSeqRef = useRef(0);
  const computeInflightRef = useRef(false);
  const pendingComputeRef = useRef<ComputeJob | null>(null);
  const scheduleSampleRef = useRef<(() => void) | null>(null);
  const requestResampleRef = useRef<(() => void) | null>(null);
  const recomputeRef = useRef<(() => void) | null>(null);
  const setLayerOpacityRef = useRef<((opacity: number) => void) | null>(null);

  const publishStatus = (status: OverlayStatusSnapshot | null) => {
    statusReporter?.(status);
  };

  useEffect(() => {
    const worker = new Worker(
      new URL('../../lib/shadowWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerAck>) => {
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
      if (sunRecomputeFrameRef.current !== null) {
        cancelAnimationFrame(sunRecomputeFrameRef.current);
        sunRecomputeFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const setLayerOpacity = (opacity: number) => {
      setShadowLayerOpacity(map, opacity);
    };

    const applyVisibleOpacity = () => {
      const current = optsRef.current;
      setLayerOpacity(effectiveOverlayOpacity(current.enabled, current.opacity, current.sunAltitudeDeg));
    };

    const ensureSourceAndLayer = (
      initialBlobUrl: string,
      coords: [[number, number], [number, number], [number, number], [number, number]],
    ) => {
      ensureShadowSourceAndLayer(map, initialBlobUrl, coords, optsRef.current);
    };

    const removeSourceAndLayer = (clearSample: boolean) => {
      removeShadowSourceAndLayer(map);
      if (clearSample) {
        sampledRef.current = false;
        sampledBoundsRef.current = null;
        computeSeqRef.current++;
        pendingComputeRef.current = null;
      }
    };

    let cancelled = false;
    setLayerOpacityRef.current = setLayerOpacity;

    const post = <T extends WorkerAck>(message: object): Promise<T> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error('worker not ready'));
      const id = ++reqIdRef.current;
      return new Promise<T>((resolve) => {
        pendingRef.current.set(id, resolve as (ack: WorkerAck) => void);
        worker.postMessage({ ...message, id });
      });
    };

    // Apply phase: takes a ready worker ack and pushes the PNG blob into the
    // Mapbox image source. Runs in parallel with the next worker compute so
    // the worker isn't idle while the main thread decodes/uploads the image.
    const applyComputeAck = async (
      job: ComputeJob,
      ack: ComputeAck | ComputeEmpty | ErrAck,
    ) => {
      if (cancelled) return;
      if (job.sampleGen !== sampleGenRef.current) return;
      // Drop stale applies — only run when this job is still the latest, or
      // when no newer compute is pending (i.e. it's the freshest result we
      // have). Skipping stale applies is the main pipelining win.
      if (
        job.computeSeq !== computeSeqRef.current
        && pendingComputeRef.current !== null
      ) {
        return;
      }
      if (ack.type === 'error') {
        console.warn('[shadow] compute failed', ack.message);
        publishStatus(shadowErrorStatus(ack.message));
        return;
      }
      if (ack.type !== 'compute-ok') {
        setLayerOpacity(0);
        publishStatus(shadowErrorStatus('Calcul vide'));
        return;
      }

      const current = optsRef.current;
      const alphaRatio = ack.totalPixels && ack.alphaPixels !== undefined
        ? ack.alphaPixels / ack.totalPixels
        : 1;
      if (
        current.sunAltitudeDeg >= 0
        && current.sunAltitudeDeg < 72
        && alphaRatio < MIN_VISIBLE_SHADOW_ALPHA_RATIO
      ) {
        console.warn('[shadow] compute produced an empty visible overlay', {
          alphaPixels: ack.alphaPixels,
          shadowPixels: ack.shadowPixels,
          totalPixels: ack.totalPixels,
          sunAltDeg: current.sunAltitudeDeg,
          sunAzDeg: current.sunAzimuthDeg,
        });
        setLayerOpacity(0);
        publishStatus(shadowErrorStatus('Image d\'ombre vide'));
        return;
      }

      const url = URL.createObjectURL(ack.blob);
      const coords: [[number, number], [number, number], [number, number], [number, number]] = [
        [job.bounds[0], job.bounds[3]],
        [job.bounds[2], job.bounds[3]],
        [job.bounds[2], job.bounds[1]],
        [job.bounds[0], job.bounds[1]],
      ];

      publishStatus(shadowLoadingStatus(86, 'Assemblage'));

      // Skip the PNG decode round-trip on preview frames during scrubbing —
      // it adds ~20-50 ms per frame that would serialize behind the next
      // worker compute. A brief flash on the first frame is acceptable; the
      // raster layer already shows the previous image until the new one
      // decodes inside Mapbox.
      if (job.quality !== 'preview') {
        await preloadBlobUrl(url);
        if (cancelled || job.sampleGen !== sampleGenRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        if (
          job.computeSeq !== computeSeqRef.current
          && pendingComputeRef.current !== null
        ) {
          URL.revokeObjectURL(url);
          return;
        }
      }

      ensureSourceAndLayer(url, coords);
      const source = map.getSource(SOURCE_ID) as ImageSource | undefined;
      if (!source || !map.getLayer(LAYER_ID)) {
        URL.revokeObjectURL(url);
        setLayerOpacity(0);
        publishStatus(shadowErrorStatus('Couche d\'ombre absente'));
        return;
      }
      try {
        source.updateImage({ url, coordinates: coords });
        applyVisibleOpacity();
      } catch (error) {
        console.warn('[shadow] updateImage failed', error);
        URL.revokeObjectURL(url);
        setLayerOpacity(0);
        publishStatus(shadowErrorStatus('Application de l\'ombre impossible'));
        return;
      }

      const previous = lastBlobUrlRef.current;
      lastBlobUrlRef.current = url;
      if (previous) {
        setTimeout(() => URL.revokeObjectURL(previous), BLOB_REVOKE_DELAY_MS);
      }

      publishStatus(shadowReadyStatus('Overlay pret'));
    };

    // Worker phase: only awaits the worker round-trip. Returns the ack so
    // the queue can immediately start the next worker compute while the
    // previous result is being applied on the main thread.
    const runWorkerCompute = async (
      job: ComputeJob,
    ): Promise<ComputeAck | ComputeEmpty | ErrAck | null> => {
      if (cancelled || !sampledRef.current) return null;
      if (job.sampleGen !== sampleGenRef.current) return null;

      publishStatus(shadowLoadingStatus(
        job.quality === 'preview' ? 62 : 68,
        job.quality === 'preview' ? 'Apercu des ombres' : 'Calcul des ombres',
      ));

      const current = optsRef.current;
      const shadowStrength = shadowVisibility(current.sunAltitudeDeg);
      const nightFloor = computeNightFloor(current.sunAltitudeDeg);
      if (!current.enabled || (current.sunAltitudeDeg >= 0 && current.opacity <= 0) || shadowStrength <= 0) {
        setLayerOpacity(0);
        return null;
      }

      const ack = await post<ComputeAck | ComputeEmpty | ErrAck>({
        type: 'compute',
        sunAzDeg: current.sunAzimuthDeg,
        sunAltDeg: current.sunAltitudeDeg,
        shadowStrength,
        nightFloor,
        quality: job.quality,
      });
      if (cancelled) return null;
      if (job.sampleGen !== sampleGenRef.current) return null;
      return ack;
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
          let ack: ComputeAck | ComputeEmpty | ErrAck | null = null;
          try {
            ack = await runWorkerCompute(job);
          } catch (error) {
            console.warn('[shadow] worker compute failed', error);
          }
          // Pipeline: kick the apply for this job in the background, then
          // immediately loop to start the next worker compute (if any).
          // The worker stays busy continuously instead of waiting on PNG
          // decode + Mapbox upload on the main thread.
          if (ack) {
            void applyComputeAck(job, ack).catch((error) => {
              console.warn('[shadow] apply error', error);
            });
          }
          job = pendingComputeRef.current;
        }
      } finally {
        computeInflightRef.current = false;
      }
    };

    const canMutateStyle = () => !cancelled && canMutateShadowStyle(map);

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
      void processComputeQueue(job).catch((error) => console.warn('[shadow] compute queue error', error));
    };

    const requestResample = () => {
      if (inflightRef.current) {
        pendingResampleRef.current = true;
        return;
      }
      inflightRef.current = true;
      runSampleAndCompute()
        .catch((error) => console.warn('[shadow] resample error', error))
        .finally(() => {
          inflightRef.current = false;
          if (pendingResampleRef.current && !cancelled && optsRef.current.enabled) {
            pendingResampleRef.current = false;
            requestResample();
          }
        });
    };

    const runSampleAndCompute = async () => {
      const current = optsRef.current;
      if (!current.enabled) return;
      if (!canMutateStyle()) {
        publishStatus(shadowLoadingStatus(6, 'Style en preparation'));
        if (sampleTimerRef.current === null) {
          sampleTimerRef.current = (setTimeout(() => {
            sampleTimerRef.current = null;
            if (!cancelled && optsRef.current.enabled) requestResample();
          }, STYLE_PREPARATION_RETRY_DELAY_MS) as unknown) as number;
        }
        return;
      }

      publishStatus(shadowLoadingStatus(12, 'Preparation'));

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

      publishStatus(shadowLoadingStatus(28, 'Echantillonnage du relief'));

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
          publishStatus(shadowReadyStatus('Dernier relief valide conserve'));
          return;
        }
        publishStatus(shadowErrorStatus(sampleAck.message));
        return;
      }
      if (sampleAck.tooMany) {
        console.info('[shadow] sample skipped: viewport spans too many DEM tiles');
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(shadowReadyStatus('Dernier relief valide conserve'));
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
          publishStatus(shadowReadyStatus('Dernier relief valide conserve'));
          return;
        }
        removeSourceAndLayer(true);
        setLayerOpacity(0);
        publishStatus(shadowErrorStatus('Aucune donnee terrain'));
        return;
      }

      const fillRatio = sampleAck.total > 0 ? sampleAck.filled / sampleAck.total : 0;
      if (fillRatio < MIN_USABLE_SAMPLE_FILL_RATIO) {
        partialSampleRetryCountRef.current++;
        if (sampleTimerRef.current !== null) {
          clearTimeout(sampleTimerRef.current);
        }
        sampleTimerRef.current = (setTimeout(() => {
          sampleTimerRef.current = null;
          if (!cancelled && optsRef.current.enabled) requestResample();
        }, PARTIAL_SAMPLE_RETRY_DELAY_MS) as unknown) as number;

        if (partialSampleRetryCountRef.current <= MAX_PARTIAL_SAMPLE_RETRIES) {
          if (hasPreviousSample) {
            applyVisibleOpacity();
          } else {
            setLayerOpacity(0);
          }
          publishStatus(shadowLoadingStatus(52, `Relief partiel (${Math.round(fillRatio * 100)}%)`));
          return;
        }

        console.warn('[shadow] sample partial: insufficient DEM coverage', {
          demZoom,
          effectiveZoom: sampleAck.effectiveZoom,
          filled: sampleAck.filled,
          total: sampleAck.total,
          fillRatio,
          bounds: sampledBounds,
        });
        if (!hasPreviousSample) {
          removeSourceAndLayer(true);
          setLayerOpacity(0);
          publishStatus(shadowErrorStatus('Relief incomplet'));
          return;
        }

        applyVisibleOpacity();
        publishStatus(shadowReadyStatus('Dernier relief valide conserve'));
        return;
      }

      partialSampleRetryCountRef.current = 0;
      sampledRef.current = true;
      sampledBoundsRef.current = sampledBounds;
      publishStatus(shadowLoadingStatus(
        58,
        sampleAck.downgraded
          ? `Relief capture (DEM z${sampleAck.effectiveZoom ?? demZoom})`
          : 'Relief capture',
      ));
      requestCompute(sampledBounds, myGen);
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

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const setLayerOpacity = setLayerOpacityRef.current;
    if (!setLayerOpacity) return;
    setLayerOpacity(effectiveOverlayOpacity(opts.enabled, opts.opacity, opts.sunAltitudeDeg));
  }, [map, isMapLoaded, opts.enabled, opts.opacity, opts.sunAltitudeDeg]);

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
