import { useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayStatusSnapshot } from '@/features/map3d';
import { useLatestRef } from '@/shared/hooks/useLatestRef';
import { sunAltitudeOvershootBucket } from '@/features/sunlight/lib/shadowSweep';
import type {
  BoundsTuple,
  UseShadowImageOptions,
  UseShadowImageRuntimeOptions,
} from '../useShadowImageShared';
import {
  effectiveOverlayOpacity,
  removeShadowSourceAndLayer,
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
  const optsRef = useLatestRef(opts);

  const sampleGenRef = useRef(0);
  const sampledRef = useRef(false);
  const sampledBoundsRef = useRef<BoundsTuple | null>(null);
  const sunRecomputeFrameRef = useRef<number | null>(null);

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

  const requestResampleRef = useLatestRef(requestResample);

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
  const recomputeRef = useLatestRef(recompute);

  const scheduleSunRecompute = useCallback(() => {
    if (sunRecomputeFrameRef.current !== null) return;
    sunRecomputeFrameRef.current = requestAnimationFrame(() => {
      sunRecomputeFrameRef.current = null;
      recomputeRef.current();
    });
  }, [recomputeRef]);

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
  }, [map, isMapLoaded, optsRef, opts.enabled, opts.analysisZone]);

  useEffect(() => {
    if (!opts.enabled) return;
    scheduleSunRecompute();
  }, [opts.sunAzimuthDeg, opts.sunAltitudeDeg, opts.enabled, scheduleSunRecompute]);

  useEffect(() => {
    applyVisibleOpacity();
  }, [opts.opacity, opts.enabled, opts.sunAltitudeDeg]);

  useEffect(() => {
    if (!registerReload) return;
    registerReload(() => {
      requestResampleRef.current();
    });
  }, [registerReload, requestResampleRef]);
}
