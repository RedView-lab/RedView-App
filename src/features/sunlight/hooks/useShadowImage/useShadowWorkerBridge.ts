import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, ImageSource } from 'mapbox-gl';
import type { OverlayStatusSnapshot } from '@/features/map3d';
import type {
  BoundsTuple,
  ComputeAck,
  ComputeEmpty,
  ComputeJob,
  ErrAck,
  UseShadowImageOptions,
  WorkerAck,
} from '../useShadowImageShared';
import {
  BLOB_REVOKE_DELAY_MS,
  computeNightFloor,
  ensureShadowSourceAndLayer,
  LAYER_ID,
  preloadBlobUrl,
  shadowVisibility,
  SOURCE_ID,
} from '../useShadowImageShared';
import { MIN_VISIBLE_SHADOW_ALPHA_RATIO } from './constants';
import {
  shadowErrorStatus,
  shadowLoadingStatus,
  shadowReadyStatus,
} from './status';

interface UseShadowWorkerBridgeArgs {
  map: MapboxMap | null;
  optsRef: React.MutableRefObject<UseShadowImageOptions>;
  sampleGenRef: React.MutableRefObject<number>;
  sampledRef: React.MutableRefObject<boolean>;
  publishStatus: (status: OverlayStatusSnapshot | null) => void;
  applyVisibleOpacity: () => void;
  setLayerOpacity: (opacity: number) => void;
}

export function useShadowWorkerBridge({
  map,
  optsRef,
  sampleGenRef,
  sampledRef,
  publishStatus,
  applyVisibleOpacity,
  setLayerOpacity,
}: UseShadowWorkerBridgeArgs) {
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastBlobUrlRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<number, (ack: WorkerAck) => void>());
  const computeSeqRef = useRef(0);
  const computeInflightRef = useRef(false);
  const pendingComputeRef = useRef<ComputeJob | null>(null);

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
    };
  }, []);

  const post = <T extends WorkerAck>(message: object): Promise<T> => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error('worker not ready'));
    const id = ++reqIdRef.current;
    return new Promise<T>((resolve) => {
      pendingRef.current.set(id, resolve as (ack: WorkerAck) => void);
      worker.postMessage({ ...message, id });
    });
  };

  const applyComputeAck = async (
    job: ComputeJob,
    ack: ComputeAck | ComputeEmpty | ErrAck,
    isCancelled: () => boolean,
  ) => {
    if (isCancelled() || !map) return;
    if (job.sampleGen !== sampleGenRef.current) return;
    if (job.computeSeq !== computeSeqRef.current && pendingComputeRef.current !== null) {
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
      setLayerOpacity(0);
      publishStatus(shadowErrorStatus("Image d'ombre vide"));
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

    if (job.quality !== 'preview') {
      await preloadBlobUrl(url);
      if (isCancelled() || job.sampleGen !== sampleGenRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (job.computeSeq !== computeSeqRef.current && pendingComputeRef.current !== null) {
        URL.revokeObjectURL(url);
        return;
      }
    }

    ensureShadowSourceAndLayer(map, url, coords, optsRef.current);
    const source = map.getSource(SOURCE_ID) as ImageSource | undefined;
    if (!source || !map.getLayer(LAYER_ID)) {
      URL.revokeObjectURL(url);
      setLayerOpacity(0);
      publishStatus(shadowErrorStatus("Couche d'ombre absente"));
      return;
    }
    try {
      source.updateImage({ url, coordinates: coords });
      applyVisibleOpacity();
    } catch (error) {
      console.warn('[shadow] updateImage failed', error);
      URL.revokeObjectURL(url);
      setLayerOpacity(0);
      publishStatus(shadowErrorStatus("Application de l'ombre impossible"));
      return;
    }

    const previous = lastBlobUrlRef.current;
    lastBlobUrlRef.current = url;
    if (previous) {
      setTimeout(() => URL.revokeObjectURL(previous), BLOB_REVOKE_DELAY_MS);
    }

    publishStatus(shadowReadyStatus('Overlay pret'));
  };

  const runWorkerCompute = async (
    job: ComputeJob,
    isCancelled: () => boolean,
  ): Promise<ComputeAck | ComputeEmpty | ErrAck | null> => {
    if (isCancelled() || !sampledRef.current) return null;
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
      zoneRing: current.analysisZone?.ring ?? null,
    });
    if (isCancelled()) return null;
    if (job.sampleGen !== sampleGenRef.current) return null;
    return ack;
  };

  const processComputeQueue = async (initialJob: ComputeJob, isCancelled: () => boolean) => {
    if (computeInflightRef.current) {
      pendingComputeRef.current = initialJob;
      return;
    }

    computeInflightRef.current = true;
    let job: ComputeJob | null = initialJob;
    try {
      while (job && !isCancelled()) {
        pendingComputeRef.current = null;
        let ack: ComputeAck | ComputeEmpty | ErrAck | null = null;
        try {
          ack = await runWorkerCompute(job, isCancelled);
        } catch (error) {
          console.warn('[shadow] worker compute failed', error);
        }
        if (ack) {
          void applyComputeAck(job, ack, isCancelled).catch((error) => {
            console.warn('[shadow] apply error', error);
          });
        }
        job = pendingComputeRef.current;
      }
    } finally {
      computeInflightRef.current = false;
    }
  };

  const requestCompute = (bounds: BoundsTuple, sampleGen: number, isCancelled: () => boolean) => {
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
    void processComputeQueue(job, isCancelled).catch((error) =>
      console.warn('[shadow] compute queue error', error),
    );
  };

  const resetBridge = () => {
    computeSeqRef.current++;
    pendingComputeRef.current = null;
  };

  return {
    post,
    requestCompute,
    resetBridge,
  };
}
