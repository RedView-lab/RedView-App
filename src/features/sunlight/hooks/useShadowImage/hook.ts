import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayStatusSnapshot } from '@/features/map3d';
import { sunAltitudeOvershootBucket } from '@/features/sunlight/lib/shadowSweep';
import type {
  BoundsTuple,
  UseShadowImageOptions,
  UseShadowImageRuntimeOptions,
} from '../useShadowImageShared';
import {
  effectiveOverlayOpacity,
  removeShadowSourceAndLayer,
  SAMPLE_DEBOUNCE_MS,
  setShadowLayerOpacity,
} from '../useShadowImageShared';
import { useShadowWorkerBridge } from './useShadowWorkerBridge';
import { useShadowSampler } from './useShadowSampler';

/**
 * Hook de calcul et rendu temps-réel de l'ombre portée du relief solaire (Shadow Image)
 * avec pipeline WebWorker découplé, overshoot adaptatif et échantillonnage DEM multi-zoom.
 */
export function useShadowImage(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  opts: UseShadowImageOptions,
  runtimeOptions: UseShadowImageRuntimeOptions = {},
): void {
  const { statusReporter, registerReload } = runtimeOptions;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const sampleGenRef = useRef(0);
  const sampledRef = useRef(false);
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
  const sunRecomputeFrameRef = useRef<number | null>(null);
  const scheduleSampleRef = useRef<(() => void) | null>(null);
  const requestResampleRef = useRef<(() => void) | null>(null);
  const recomputeRef = useRef<(() => void) | null>(null);
  const setLayerOpacityRef = useRef<((opacity: number) => void) | null>(null);

  const publishStatus = (status: OverlayStatusSnapshot | null) => {
    statusReporter?.(status);
  };

  const setLayerOpacity = (opacity: number) => {
    if (map) setShadowLayerOpacity(map, opacity);
  };

  const applyVisibleOpacity = () => {
    const current = optsRef.current;
    setLayerOpacity(effectiveOverlayOpacity(current.enabled, current.opacity, current.sunAltitudeDeg));
  };

  const { post, requestCompute, resetBridge } = useShadowWorkerBridge({
    map,
    optsRef,
    sampleGenRef,
    sampledRef,
    publishStatus,
    applyVisibleOpacity,
    setLayerOpacity,
  });

  const removeSourceAndLayer = (clearSample: boolean) => {
    if (map) removeShadowSourceAndLayer(map);
    if (clearSample) {
      sampledRef.current = false;
      sampledBoundsRef.current = null;
      resetBridge();
    }
  };

  const isCancelledRef = useRef(false);

  const {
    requestResample,
    cancelTimers,
    overshootBucketRef,
  } = useShadowSampler({
    map,
    optsRef,
    sampleGenRef,
    sampledRef,
    sampledBoundsRef,
    post,
    requestCompute,
    publishStatus,
    applyVisibleOpacity,
    setLayerOpacity,
    removeSourceAndLayer,
    isCancelled: () => isCancelledRef.current,
  });

  requestResampleRef.current = requestResample;
  setLayerOpacityRef.current = setLayerOpacity;

  const recompute = () => {
    if (!sampledRef.current || !sampledBoundsRef.current) return;
    const current = optsRef.current;
    const targetBucket = sunAltitudeOvershootBucket(current.sunAltitudeDeg);
    if (overshootBucketRef.current !== null && targetBucket < overshootBucketRef.current) {
      requestResample();
      return;
    }
    requestCompute(sampledBoundsRef.current, sampleGenRef.current, () => isCancelledRef.current);
  };
  recomputeRef.current = recompute;

  const scheduleSunRecompute = () => {
    if (sunRecomputeFrameRef.current !== null) return;
    sunRecomputeFrameRef.current = requestAnimationFrame(() => {
      sunRecomputeFrameRef.current = null;
      recomputeRef.current?.();
    });
  };

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
      removeSourceAndLayer(true);
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
      map.off('moveend', onMoveEnd);
    };
  }, [map, isMapLoaded, opts.enabled, opts.analysisZone]);

  useEffect(() => {
    if (!opts.enabled) return;
    scheduleSunRecompute();
  }, [opts.sunAzimuthDeg, opts.sunAltitudeDeg, opts.enabled]);

  useEffect(() => {
    applyVisibleOpacity();
  }, [opts.opacity, opts.enabled, opts.sunAltitudeDeg]);

  useEffect(() => {
    if (!registerReload) return;
    registerReload(() => {
      requestResampleRef.current?.();
    });
  }, [registerReload]);
}
