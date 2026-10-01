import type {
  ComparisonResult,
  FitWorkerRequest,
  FitWorkerResponse,
  PredictionConfig,
  PredictionResult,
  RunPredictionConfig,
} from '../types';

type PendingRequest = {
  resolve: (value: PredictionResult | ComparisonResult) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (message: string) => void;
};

export function createFitPredictionEngine() {
  let idCounter = 0;
  const pending = new Map<number, PendingRequest>();

  function handleMessage(event: MessageEvent<FitWorkerResponse>) {
    const message = event.data;
    const entry = pending.get(message._id);
    if (!entry) {
      return;
    }

    if (message.type === 'progress') {
      entry.onProgress?.(message.message);
      return;
    }

    pending.delete(message._id);

    if (message.type === 'error') {
      entry.reject(new Error(message.message));
      return;
    }

    entry.resolve(message.data);
  }

  function spawnWorker(): Worker {
    const next = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    next.onmessage = handleMessage;
    next.onerror = (event) => {
      const error = new Error(event.message || 'Prediction worker crashed');
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
      // Un worker planté (erreur de chargement du module, panique WASM…)
      // ne répondra plus : il est remplacé à la requête suivante (création
      // paresseuse, pas de boucle si le module ne se charge toujours pas).
      next.terminate();
      if (worker === next) worker = null;
    };
    return next;
  }

  let worker: Worker | null = spawnWorker();

  function getWorker(): Worker {
    worker ??= spawnWorker();
    return worker;
  }

  function send<T extends PredictionResult | ComparisonResult>(
    request: FitWorkerRequest,
    transferables: Transferable[],
    onProgress?: (message: string) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.set(request._id, { resolve: resolve as PendingRequest['resolve'], reject, onProgress });
      getWorker().postMessage(request, transferables);
    });
  }

  return {
    async predict(
      fitFiles: readonly File[],
      gpxFile: File,
      config?: PredictionConfig,
      onProgress?: (message: string) => void,
    ): Promise<PredictionResult> {
      const fitBuffers = await Promise.all(fitFiles.map((file) => file.arrayBuffer()));
      const gpxBuffer = await gpxFile.arrayBuffer();
      const request: FitWorkerRequest = {
        _id: ++idCounter,
        type: 'predict',
        fitFiles: fitBuffers,
        gpxData: gpxBuffer,
        config,
      };

      return send<PredictionResult>(request, [...fitBuffers, gpxBuffer], onProgress);
    },

    async predictRun(
      fitFiles: readonly File[],
      gpxFile: File,
      config: RunPredictionConfig,
      onProgress?: (message: string) => void,
    ): Promise<PredictionResult> {
      const fitBuffers = await Promise.all(fitFiles.map((file) => file.arrayBuffer()));
      const gpxBuffer = await gpxFile.arrayBuffer();
      const request: FitWorkerRequest = {
        _id: ++idCounter,
        type: 'predictRun',
        fitFiles: fitBuffers,
        gpxData: gpxBuffer,
        config,
      };

      return send<PredictionResult>(request, [...fitBuffers, gpxBuffer], onProgress);
    },

    async compare(
      fitFiles: readonly File[],
      validationFit: File,
      config?: PredictionConfig,
    ): Promise<ComparisonResult> {
      const fitBuffers = await Promise.all(fitFiles.map((file) => file.arrayBuffer()));
      const validationBuffer = await validationFit.arrayBuffer();
      const request: FitWorkerRequest = {
        _id: ++idCounter,
        type: 'compare',
        fitFiles: fitBuffers,
        validationFit: validationBuffer,
        config,
      };

      return send<ComparisonResult>(request, [...fitBuffers, validationBuffer]);
    },

    terminate(): void {
      worker?.terminate();
      worker = null;
      for (const entry of pending.values()) {
        entry.reject(new Error('Prediction worker terminated'));
      }
      pending.clear();
    },
  };
}