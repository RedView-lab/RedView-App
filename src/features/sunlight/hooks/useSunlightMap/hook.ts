import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { getSunPositionForLocalMinutes } from '@/features/sunlight/lib/sun-calc';
import { sunAltitudeOvershootBucket } from '@/features/sunlight/lib/shadowSweep';
import {
  COMPUTE_DEBOUNCE_MS,
  effectiveLayerOpacity,
  hashBandPayload,
  parseTimeToMinutes,
  removeSunlightMapSourceAndLayer,
  SAMPLE_DEBOUNCE_MS,
  serializeBands,
  setSunlightMapLayerOpacity,
  type BoundsTuple,
  type UseSunlightMapOptions,
  type UseSunlightMapRuntimeOptions,
} from './shared';
import { useSunlightWorkerBridge } from './useSunlightWorkerBridge';
import { useSunlightSampler } from './useSunlightSampler';

/**
 * Hook de calcul et rendu de la carte d'ensoleillement cumulé (Sunlight Map)
 * avec intégration temporelle en tranches, worker dédié et recalibrage automatique des bandes.
 */
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

  const sampleGenRef = useRef(0);
  const sampledRef = useRef(false);
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
  const computeTimerRef = useRef<number | null>(null);
  const isCancelledRef = useRef(false);

  const scheduleSampleRef = useRef<(() => void) | null>(null);
  const requestResampleRef = useRef<(() => void) | null>(null);
  const scheduleComputeRef = useRef<(() => void) | null>(null);

  const publishStatus = (status: Parameters<NonNullable<typeof statusReporter>>[0]) => {
    statusReporterRef.current?.(status);
  };

  const applyVisibleOpacity = () => {
    const current = optsRef.current;
    if (map) setSunlightMapLayerOpacity(map, effectiveLayerOpacity(current.enabled, current.opacity));
  };

  const setLayerOpacity = (opacity: number) => {
    if (map) setSunlightMapLayerOpacity(map, opacity);
  };

  const {
    postSample,
    processComputeQueue,
    resetWorkerBridge,
    computeSeqRef,
    computeInflightRef,
    pendingComputeRef,
  } = useSunlightWorkerBridge({
    map,
    optsRef,
    bandsPayloadRef,
    sampleGenRef,
    sampledRef,
    publishStatus,
    applyVisibleOpacity,
  });

  const removeOverlay = (clearSample: boolean) => {
    if (map) removeSunlightMapSourceAndLayer(map);
    if (clearSample) {
      sampledRef.current = false;
      sampledBoundsRef.current = null;
      resetWorkerBridge();
    }
  };

  const {
    enqueueCompute,
    requestResample,
    cancelTimers,
    overshootBucketRef,
  } = useSunlightSampler({
    map,
    optsRef,
    sampleGenRef,
    sampledRef,
    sampledBoundsRef,
    postSample,
    processComputeQueue,
    publishStatus,
    applyVisibleOpacity,
    setLayerOpacity,
    removeOverlay,
    computeSeqRef,
    computeInflightRef,
    pendingComputeRef,
    isCancelled: () => isCancelledRef.current,
  });

  requestResampleRef.current = requestResample;

  const scheduleCompute = () => {
    if (computeTimerRef.current !== null) clearTimeout(computeTimerRef.current);
    computeTimerRef.current = (setTimeout(() => {
      computeTimerRef.current = null;
      enqueueCompute();
    }, COMPUTE_DEBOUNCE_MS) as unknown) as number;
  };
  scheduleComputeRef.current = scheduleCompute;

  const scheduleSample = () => {
    let timer: number | null = null;
    timer = (setTimeout(() => {
      if (!isCancelledRef.current) requestResampleRef.current?.();
    }, SAMPLE_DEBOUNCE_MS) as unknown) as number;
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  };
  scheduleSampleRef.current = scheduleSample;

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    isCancelledRef.current = false;

    if (opts.enabled) {
      requestResample();
    } else {
      removeOverlay(true);
      setLayerOpacity(0);
      publishStatus(null);
    }

    const onMoveEnd = () => {
      if (optsRef.current.enabled && !optsRef.current.analysisZone) {
        requestResample();
      }
    };

    map.on('moveend', onMoveEnd);

    return () => {
      isCancelledRef.current = true;
      cancelTimers();
      if (computeTimerRef.current !== null) {
        clearTimeout(computeTimerRef.current);
        computeTimerRef.current = null;
      }
      map.off('moveend', onMoveEnd);
    };
  }, [map, isMapLoaded, opts.enabled, opts.analysisZone]);

  useEffect(() => {
    if (!opts.enabled) return;
    if (!sampledRef.current || !sampledBoundsRef.current) return;
    const currentMinutes = parseTimeToMinutes(opts.time);
    const sunNow = (Number.isFinite(opts.observerLat) && Number.isFinite(opts.observerLon))
      ? getSunPositionForLocalMinutes(
          opts.date,
          currentMinutes,
          opts.observerLat as number,
          opts.observerLon as number,
          opts.observerTimeZone ?? undefined,
        )
      : null;
    const sunAltDeg = sunNow ? sunNow.altitude : 45;
    const targetBucket = sunAltitudeOvershootBucket(sunAltDeg);
    if (overshootBucketRef.current !== null && targetBucket < overshootBucketRef.current) {
      requestResample();
      return;
    }
    if (opts.timeScrubbing) {
      enqueueCompute();
    } else {
      scheduleCompute();
    }
  }, [opts.date, opts.time, opts.enabled, bandsHash, opts.timeScrubbing, opts.observerLat, opts.observerLon, opts.observerTimeZone]);

  useEffect(() => {
    applyVisibleOpacity();
  }, [opts.opacity, opts.enabled]);

  useEffect(() => {
    if (!registerReload) return;
    registerReload(() => {
      requestResampleRef.current?.();
    });
  }, [registerReload]);
}
