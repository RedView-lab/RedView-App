import { useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { getSunPositionForLocalMinutes } from '@/features/sunlight/lib/sun-calc';
import {
  BOUNDS_OVERSHOOT,
  canMutateMapStyle,
  chooseAdaptiveOvershoot,
  chooseDemZoom,
  chooseGridSize,
  chooseZoneDemZoom,
  chooseZoneGridSize,
  MAX_PARTIAL_SAMPLE_RETRIES,
  MIN_USABLE_SAMPLE_FILL_RATIO,
  PARTIAL_SAMPLE_RETRY_DELAY_MS,
  parseTimeToMinutes,
  STYLE_PREPARATION_RETRY_DELAY_MS,
  withOvershoot,
  type BoundsTuple,
  type ComputeJob,
  type SmErrAck,
  type SmSampleAck,
  type UseSunlightMapOptions,
} from './shared';
import {
  sunlightMapErrorStatus,
  sunlightMapLoadingStatus,
  sunlightMapReadyStatus,
} from './status';

interface UseSunlightSamplerArgs {
  map: MapboxMap | null;
  optsRef: React.MutableRefObject<UseSunlightMapOptions>;
  sampleGenRef: React.MutableRefObject<number>;
  sampledRef: React.MutableRefObject<boolean>;
  sampledBoundsRef: React.MutableRefObject<BoundsTuple | null>;
  postSample: (message: object) => Promise<SmSampleAck | SmErrAck>;
  processComputeQueue: (job: ComputeJob, isCancelled: () => boolean) => Promise<void>;
  publishStatus: (status: ReturnType<typeof sunlightMapLoadingStatus> | null) => void;
  applyVisibleOpacity: () => void;
  setLayerOpacity: (opacity: number) => void;
  removeOverlay: (clearSample: boolean) => void;
  computeSeqRef: React.MutableRefObject<number>;
  computeInflightRef: React.MutableRefObject<boolean>;
  pendingComputeRef: React.MutableRefObject<ComputeJob | null>;
  isCancelled: () => boolean;
}

export function useSunlightSampler({
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
  isCancelled,
}: UseSunlightSamplerArgs) {
  const sampleTimerRef = useRef<number | null>(null);
  const inflightSampleRef = useRef(false);
  const pendingResampleRef = useRef(false);
  const partialSampleRetryRef = useRef(0);
  const overshootBucketRef = useRef<number | null>(null);
  const activeOvershootRef = useRef<number>(BOUNDS_OVERSHOOT);

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
    void processComputeQueue(job, isCancelled).catch((err) =>
      console.warn('[sunlight-map] compute queue error', err),
    );
  };

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
        if (pendingResampleRef.current && !isCancelled() && optsRef.current.enabled) {
          pendingResampleRef.current = false;
          requestResample();
        }
      });
  };

  const runSampleAndCompute = async () => {
    const current = optsRef.current;
    if (!current.enabled || !map) return;
    if (!canMutateMapStyle(map)) {
      publishStatus(sunlightMapLoadingStatus(6, 'Style en preparation'));
      if (sampleTimerRef.current === null) {
        sampleTimerRef.current = (setTimeout(() => {
          sampleTimerRef.current = null;
          if (!isCancelled() && optsRef.current.enabled) requestResample();
        }, STYLE_PREPARATION_RETRY_DELAY_MS) as unknown) as number;
      }
      return;
    }

    publishStatus(sunlightMapLoadingStatus(14, 'Preparation'));

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

    const currentMinutes = parseTimeToMinutes(current.time);
    const sunNow = Number.isFinite(current.observerLat) && Number.isFinite(current.observerLon)
      ? getSunPositionForLocalMinutes(
          current.date,
          currentMinutes,
          current.observerLat as number,
          current.observerLon as number,
          current.observerTimeZone ?? undefined,
        )
      : null;
    const sunAltDeg = sunNow ? sunNow.altitude : 45;
    const overshootInfo = chooseAdaptiveOvershoot(
      rawBoundsTuple,
      sunAltDeg,
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

    publishStatus(sunlightMapLoadingStatus(18, 'Echantillonnage du relief'));

    const sampleAck = await postSample({
      type: 'sm-sample',
      bounds: sampledBounds,
      gridW,
      gridH,
      demZoom,
    });
    if (isCancelled() || myGen !== sampleGenRef.current) return;

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
      setLayerOpacity(0);
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
      setLayerOpacity(0);
      publishStatus(sunlightMapErrorStatus('Aucune donnee terrain'));
      return;
    }

    const fillRatio = sampleAck.total > 0 ? sampleAck.filled / sampleAck.total : 0;
    if (fillRatio < MIN_USABLE_SAMPLE_FILL_RATIO) {
      partialSampleRetryRef.current++;
      if (sampleTimerRef.current !== null) clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = (setTimeout(() => {
        sampleTimerRef.current = null;
        if (!isCancelled() && optsRef.current.enabled) requestResample();
      }, PARTIAL_SAMPLE_RETRY_DELAY_MS) as unknown) as number;

      if (hasPreviousSample) {
        applyVisibleOpacity();
        publishStatus(sunlightMapReadyStatus('Dernier relief valide conserve'));
      } else {
        publishStatus(sunlightMapLoadingStatus(
          20,
          `Relief partiel (${Math.round(fillRatio * 100)}%) — nouvel essai`,
        ));
      }
      if (partialSampleRetryRef.current < MAX_PARTIAL_SAMPLE_RETRIES) {
        return;
      }
    }

    partialSampleRetryRef.current = 0;
    sampledRef.current = true;
    sampledBoundsRef.current = sampledBounds;
    enqueueCompute();
  };

  const cancelTimers = () => {
    if (sampleTimerRef.current !== null) {
      clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
  };

  return {
    enqueueCompute,
    requestResample,
    cancelTimers,
    overshootBucketRef,
  };
}
