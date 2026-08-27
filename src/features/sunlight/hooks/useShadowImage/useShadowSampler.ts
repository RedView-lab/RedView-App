import { useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayStatusSnapshot } from '@/features/map3d';
import type {
  BoundsTuple,
  ErrAck,
  SampleAck,
  UseShadowImageOptions,
  WorkerAck,
} from '../useShadowImageShared';
import {
  BOUNDS_OVERSHOOT,
  canMutateShadowStyle,
  chooseAdaptiveOvershoot,
  chooseDemZoom,
  chooseGridSize,
  chooseZoneDemZoom,
  chooseZoneGridSize,
  withOvershoot,
} from '../useShadowImageShared';
import {
  MAX_PARTIAL_SAMPLE_RETRIES,
  MIN_USABLE_SAMPLE_FILL_RATIO,
  PARTIAL_SAMPLE_RETRY_DELAY_MS,
  STYLE_PREPARATION_RETRY_DELAY_MS,
} from './constants';
import {
  shadowErrorStatus,
  shadowLoadingStatus,
  shadowReadyStatus,
} from './status';

interface UseShadowSamplerArgs {
  map: MapboxMap | null;
  optsRef: React.MutableRefObject<UseShadowImageOptions>;
  sampleGenRef: React.MutableRefObject<number>;
  sampledRef: React.MutableRefObject<boolean>;
  sampledBoundsRef: React.MutableRefObject<BoundsTuple | null>;
  post: <T extends WorkerAck>(message: object) => Promise<T>;
  requestCompute: (bounds: BoundsTuple, sampleGen: number, isCancelled: () => boolean) => void;
  publishStatus: (status: OverlayStatusSnapshot | null) => void;
  applyVisibleOpacity: () => void;
  setLayerOpacity: (opacity: number) => void;
  removeSourceAndLayer: (clearSample: boolean) => void;
  isCancelled: () => boolean;
}

export function useShadowSampler({
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
  isCancelled,
}: UseShadowSamplerArgs) {
  const sampleTimerRef = useRef<number | null>(null);
  const partialSampleRetryCountRef = useRef(0);
  const inflightRef = useRef(false);
  const pendingResampleRef = useRef(false);
  const overshootBucketRef = useRef<number | null>(null);
  const activeOvershootRef = useRef<number>(BOUNDS_OVERSHOOT);

  const canMutateStyle = () => !isCancelled() && Boolean(map) && canMutateShadowStyle(map!);

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
        if (pendingResampleRef.current && !isCancelled() && optsRef.current.enabled) {
          pendingResampleRef.current = false;
          requestResample();
        }
      });
  };

  const runSampleAndCompute = async () => {
    const current = optsRef.current;
    if (!current.enabled || !map) return;
    if (!canMutateStyle()) {
      publishStatus(shadowLoadingStatus(6, 'Style en preparation'));
      if (sampleTimerRef.current === null) {
        sampleTimerRef.current = (setTimeout(() => {
          sampleTimerRef.current = null;
          if (!isCancelled() && optsRef.current.enabled) requestResample();
        }, STYLE_PREPARATION_RETRY_DELAY_MS) as unknown) as number;
      }
      return;
    }

    publishStatus(shadowLoadingStatus(12, 'Preparation'));

    const myGen = ++sampleGenRef.current;
    const zone = current.analysisZone ?? null;
    const rawBounds = map.getBounds();
    if (!rawBounds && !zone) return;
    const rawBoundsTuple: BoundsTuple = zone
      ? zone.bounds
      : [
          rawBounds!.getWest(),
          rawBounds!.getSouth(),
          rawBounds!.getEast(),
          rawBounds!.getNorth(),
        ];

    const overshootInfo = chooseAdaptiveOvershoot(
      rawBoundsTuple,
      current.sunAltitudeDeg,
      overshootBucketRef.current,
    );
    const overshootFactor = overshootInfo.resample
      ? overshootInfo.overshoot
      : activeOvershootRef.current;
    if (overshootInfo.resample) {
      overshootBucketRef.current = overshootInfo.bucket;
      activeOvershootRef.current = overshootFactor;
    }
    const sampledBounds = withOvershoot(rawBoundsTuple, overshootFactor);
    const { gridW, gridH } = zone
      ? chooseZoneGridSize(sampledBounds)
      : chooseGridSize(map);
    const demZoom = zone
      ? chooseZoneDemZoom(sampledBounds, gridW)
      : chooseDemZoom(map, gridW);

    publishStatus(shadowLoadingStatus(28, 'Echantillonnage du relief'));

    const sampleAck = await post<SampleAck | ErrAck>({
      type: 'sample',
      bounds: sampledBounds,
      gridW,
      gridH,
      demZoom,
    });
    if (isCancelled() || myGen !== sampleGenRef.current) return;
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
      const isBoundaryCoverage = fillRatio >= 0.30;

      if (isBoundaryCoverage) {
        partialSampleRetryCountRef.current = 0;
        sampledRef.current = true;
        sampledBoundsRef.current = sampledBounds;
        publishStatus(shadowLoadingStatus(
          58,
          `Relief partiel (${Math.round(fillRatio * 100)}%)`,
        ));
        requestCompute(sampledBounds, myGen, isCancelled);
        return;
      }

      if (partialSampleRetryCountRef.current < MAX_PARTIAL_SAMPLE_RETRIES) {
        partialSampleRetryCountRef.current++;
        console.info(
          `[shadow] sample partially filled (${sampleAck.filled}/${sampleAck.total}); retrying (${partialSampleRetryCountRef.current}/${MAX_PARTIAL_SAMPLE_RETRIES})`,
        );
        if (hasPreviousSample) {
          applyVisibleOpacity();
          publishStatus(shadowReadyStatus('Dernier relief valide conserve'));
        } else {
          publishStatus(shadowLoadingStatus(
            34,
            `Chargement du relief (${Math.round(fillRatio * 100)}%)`,
          ));
        }
        if (sampleTimerRef.current === null) {
          sampleTimerRef.current = (setTimeout(() => {
            sampleTimerRef.current = null;
            if (!isCancelled() && optsRef.current.enabled) requestResample();
          }, PARTIAL_SAMPLE_RETRY_DELAY_MS) as unknown) as number;
        }
        return;
      }

      console.warn(
        `[shadow] sample partially filled after retries (${sampleAck.filled}/${sampleAck.total}); computing anyway`,
      );
    }

    partialSampleRetryCountRef.current = 0;
    sampledRef.current = true;
    sampledBoundsRef.current = sampledBounds;
    requestCompute(sampledBounds, myGen, isCancelled);
  };

  const cancelTimers = () => {
    if (sampleTimerRef.current !== null) {
      clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
  };

  return {
    requestResample,
    cancelTimers,
    overshootBucketRef,
    activeOvershootRef,
  };
}
