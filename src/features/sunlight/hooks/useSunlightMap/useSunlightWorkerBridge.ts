import { useEffect, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';
import {
  BLOB_REVOKE_DELAY_MS,
  STEP_MINUTES,
  SUNLIGHT_MAP_LAYER_ID,
  SUNLIGHT_MAP_SOURCE_ID,
  effectiveLayerOpacity,
  ensureSunlightMapSourceAndLayer,
  parseTimeToMinutes,
  preloadBlobUrl,
  setSunlightMapLayerOpacity,
  type BandPayload,
  type ComputeJob,
  type SmComputeAck,
  type SmComputeCancelled,
  type SmComputeEmpty,
  type SmErrAck,
  type SmSampleAck,
  type SunlightMapWorkerAck,
  type UseSunlightMapOptions,
} from './shared';
import {
  sunlightMapErrorStatus,
  sunlightMapLoadingStatus,
  sunlightMapReadyStatus,
} from './status';

export type ComputeTerminal = SmComputeAck | SmComputeEmpty | SmComputeCancelled | SmErrAck;

interface UseSunlightWorkerBridgeArgs {
  map: MapboxMap | null;
  optsRef: React.MutableRefObject<UseSunlightMapOptions>;
  bandsPayloadRef: React.MutableRefObject<BandPayload[]>;
  sampleGenRef: React.MutableRefObject<number>;
  sampledRef: React.MutableRefObject<boolean>;
  publishStatus: (status: ReturnType<typeof sunlightMapLoadingStatus> | null) => void;
  applyVisibleOpacity: () => void;
}

export function useSunlightWorkerBridge({
  map,
  optsRef,
  bandsPayloadRef,
  sampleGenRef,
  sampledRef,
  publishStatus,
  applyVisibleOpacity,
}: UseSunlightWorkerBridgeArgs) {
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastBlobUrlRef = useRef<string | null>(null);
  const computeResolversRef = useRef(new Map<number, (ack: ComputeTerminal) => void>());
  const sampleResolversRef = useRef(new Map<number, (ack: SmSampleAck | SmErrAck) => void>());
  const activeComputeIdRef = useRef<number | null>(null);
  const computeSeqRef = useRef(0);
  const computeInflightRef = useRef(false);
  const pendingComputeRef = useRef<ComputeJob | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('../../lib/sunlightMapWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SunlightMapWorkerAck>) => {
      const ack = event.data;
      if (ack.type === 'sm-progress') {
        if (activeComputeIdRef.current === ack.id) {
          const totalSteps = Math.max(1, ack.totalSteps);
          const pct = Math.round((ack.stepsDone / totalSteps) * 70) + 22;
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
  }, [publishStatus]);

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

  const runComputeAndApply = async (job: ComputeJob, isCancelled: () => boolean) => {
    if (isCancelled() || !sampledRef.current || !map) return;
    if (job.sampleGen !== sampleGenRef.current) return;
    if (job.computeSeq !== computeSeqRef.current) return;

    const current = optsRef.current;
    if (!current.enabled) {
      setSunlightMapLayerOpacity(map, 0);
      return;
    }

    const bounds = map.getBounds();
    if (!bounds) return;
    if (!Number.isFinite(current.observerLat) || !Number.isFinite(current.observerLon) || !current.observerTimeZone) {
      setSunlightMapLayerOpacity(map, 0);
      publishStatus(sunlightMapErrorStatus('Point soleil indisponible'));
      return;
    }
    const currentMinutes = parseTimeToMinutes(current.time);

    publishStatus(sunlightMapLoadingStatus(20, 'Calcul en cours'));

    const ack = await postCompute({
      type: 'sm-compute',
      isoDate: current.date,
      currentMinutes,
      stepMinutes: STEP_MINUTES,
      observerLat: current.observerLat,
      observerLon: current.observerLon,
      observerTimeZone: current.observerTimeZone,
      bands: bandsPayloadRef.current,
      opacity: Math.max(0, Math.min(1, current.opacity)),
      quality: current.timeScrubbing ? 'preview' : 'full',
      zoneRing: current.analysisZone?.ring ?? null,
    });

    if (isCancelled()) return;
    if (job.sampleGen !== sampleGenRef.current) return;
    if (job.computeSeq !== computeSeqRef.current) return;

    if (ack.type === 'sm-compute-cancelled') {
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
    if (isCancelled() || job.sampleGen !== sampleGenRef.current || job.computeSeq !== computeSeqRef.current) {
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
        await runComputeAndApply(job, isCancelled);
        job = pendingComputeRef.current;
      }
    } finally {
      computeInflightRef.current = false;
    }
  };

  const resetWorkerBridge = () => {
    computeSeqRef.current++;
    pendingComputeRef.current = null;
    activeComputeIdRef.current = null;
  };

  return {
    postSample,
    postCompute,
    processComputeQueue,
    resetWorkerBridge,
    computeSeqRef,
    computeInflightRef,
    pendingComputeRef,
  };
}
