import type {
  ComparisonResult,
  CyclingCalibration,
  CyclingConfig,
  CyclingRouteInput,
  FitWorkerRequest,
  FitWorkerResponse,
  PredictionConfig,
  PredictionResult,
  RunPredictionConfig,
} from '../types';

type EngineResult = PredictionResult | ComparisonResult | CyclingCalibration;

type PendingRequest = {
  resolve: (value: EngineResult) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (message: string) => void;
};

type QueuedRequest = {
  request: FitWorkerRequest;
  transferables: Transferable[];
  /** Clé de regroupement (ex. id d'itinéraire) : une requête plus récente remplace celles en attente. */
  key: string | null;
  entry: PendingRequest;
};

export interface FitEngineRequestOptions {
  /**
   * Requêtes de même clé : quand une nouvelle est mise en file, les plus
   * anciennes pas encore démarrées sont abandonnées (rejetées avec
   * `FitPredictionCancelledError`, raison `superseded`).
   */
  key?: string;
}

/** Requête abandonnée (remplacée par une plus récente, annulée, moteur arrêté) : pas une erreur à afficher. */
export class FitPredictionCancelledError extends Error {
  readonly reason: 'superseded' | 'cancelled' | 'terminated';

  constructor(reason: 'superseded' | 'cancelled' | 'terminated') {
    super(reason === 'terminated' ? 'Prediction worker terminated' : `Prediction ${reason}`);
    this.name = 'FitPredictionCancelledError';
    this.reason = reason;
  }
}

/** Panique du moteur Rust : message lisible plutôt que « unreachable » (traduit par le DOM). */
const ENGINE_PANIC_MESSAGE = 'Le moteur de prédiction a rencontré une erreur interne : relancez le calcul.';

export function createFitPredictionEngine() {
  let idCounter = 0;
  // Le worker est mono-thread et `predict()` est synchrone : une seule
  // requête lui est confiée à la fois, les autres attendent ici, où l'on peut
  // encore les abandonner (impossible une fois postées au worker).
  const queue: QueuedRequest[] = [];
  let inFlight: QueuedRequest | null = null;

  function settleInFlight(): QueuedRequest | null {
    const current = inFlight;
    inFlight = null;
    return current;
  }

  function handleMessage(event: MessageEvent<FitWorkerResponse>) {
    const message = event.data;
    if (!inFlight || inFlight.request._id !== message._id) {
      return;
    }

    if (message.type === 'progress') {
      inFlight.entry.onProgress?.(message.message);
      return;
    }

    const done = settleInFlight()!;
    if (message.type === 'error' && message.fatal) {
      // Panique du moteur : ce worker s'est fermé, un neuf servira la suite.
      const failed = worker;
      worker = null;
      failed?.terminate();
      console.warn('[fitPredictor] engine panic, worker replaced:', message.message);
      done.entry.reject(new Error(ENGINE_PANIC_MESSAGE));
    } else if (message.type === 'error') {
      done.entry.reject(new Error(message.message));
    } else {
      done.entry.resolve(message.data);
    }
    pump();
  }

  function spawnWorker(): Worker {
    const next = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    next.onmessage = handleMessage;
    next.onerror = (event) => {
      // Un worker planté (erreur de chargement du module, panique WASM…)
      // ne répondra plus : la requête en cours échoue, il est remplacé à la
      // requête suivante (création paresseuse, pas de boucle de redémarrage).
      next.terminate();
      if (worker !== next) return;
      worker = null;
      settleInFlight()?.entry.reject(new Error(event.message || 'Prediction worker crashed'));
      pump();
    };
    return next;
  }

  let worker: Worker | null = spawnWorker();

  function getWorker(): Worker {
    worker ??= spawnWorker();
    return worker;
  }

  function pump(): void {
    if (inFlight) return;
    const next = queue.shift();
    if (!next) return;
    inFlight = next;
    getWorker().postMessage(next.request, next.transferables);
  }

  function send<T extends EngineResult>(
    request: FitWorkerRequest,
    transferables: Transferable[],
    onProgress?: (message: string) => void,
    options?: FitEngineRequestOptions,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const key = options?.key ?? null;
      if (key !== null) {
        // Supersede : les requêtes de même clé encore en attente sont périmées.
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i]!.key !== key) continue;
          const [dropped] = queue.splice(i, 1);
          dropped!.entry.reject(new FitPredictionCancelledError('superseded'));
        }
      }
      queue.push({
        request,
        transferables,
        key,
        entry: { resolve: resolve as PendingRequest['resolve'], reject, onProgress },
      });
      pump();
    });
  }

  return {
    async predict(
      fitFiles: readonly File[],
      gpxFile: File,
      config?: PredictionConfig,
      onProgress?: (message: string) => void,
      options?: FitEngineRequestOptions,
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

      return send<PredictionResult>(request, [...fitBuffers, gpxBuffer], onProgress, options);
    },

    async predictRun(
      fitFiles: readonly File[],
      gpxFile: File,
      config: RunPredictionConfig,
      onProgress?: (message: string) => void,
      options?: FitEngineRequestOptions,
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

      return send<PredictionResult>(request, [...fitBuffers, gpxBuffer], onProgress, options);
    },

    /** Moteur vélo v2 : calibre un cycliste sur ses .fit (prior = `config.rider`). */
    async calibrateCycling(
      fitFiles: readonly File[],
      config: CyclingConfig,
      onProgress?: (message: string) => void,
      options?: FitEngineRequestOptions,
    ): Promise<CyclingCalibration> {
      const fitBuffers = await Promise.all(fitFiles.map((file) => file.arrayBuffer()));
      const request: FitWorkerRequest = {
        _id: ++idCounter,
        type: 'calibrateCycling',
        fitFiles: fitBuffers,
        config,
      };
      return send<CyclingCalibration>(request, fitBuffers, onProgress, options);
    },

    /** Moteur vélo v2 : temps de déplacement sur un tracé (tableaux transférés). */
    predictCycling(
      route: CyclingRouteInput,
      config: CyclingConfig,
      onProgress?: (message: string) => void,
      options?: FitEngineRequestOptions,
    ): Promise<PredictionResult> {
      const request: FitWorkerRequest = {
        _id: ++idCounter,
        type: 'predictCycling',
        route,
        config,
      };
      const transferables = [route.lat, route.lon, route.ele, route.dist, route.surface, route.way, route.headwind]
        .map((array) => array.buffer as ArrayBuffer);
      return send<PredictionResult>(request, transferables, onProgress, options);
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

    /**
     * Annule les requêtes d'une clé (en attente et en cours) sans toucher aux
     * autres : si celle en cours est concernée, le worker est arrêté (seul
     * moyen d'interrompre le calcul WASM synchrone) et les requêtes des autres
     * clés reprennent sur un worker neuf.
     */
    cancel(key: string): void {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]!.key !== key) continue;
        const [dropped] = queue.splice(i, 1);
        dropped!.entry.reject(new FitPredictionCancelledError('cancelled'));
      }
      if (inFlight?.key === key) {
        worker?.terminate();
        worker = null;
        settleInFlight()!.entry.reject(new FitPredictionCancelledError('cancelled'));
      }
      pump();
    },

    terminate(): void {
      worker?.terminate();
      worker = null;
      const error = new FitPredictionCancelledError('terminated');
      settleInFlight()?.entry.reject(error);
      for (const queued of queue.splice(0)) {
        queued.entry.reject(error);
      }
    },
  };
}
