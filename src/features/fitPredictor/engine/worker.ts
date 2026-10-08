/// <reference lib="webworker" />

import init, {
  calibrate_cycling,
  predict,
  predict_cycling,
  predict_run,
  predict_vs_actual,
} from './pkg/redviewalgo.js';
import type { FitWorkerRequest, FitWorkerResponse } from '../types';

let wasmReady = false;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (wasmReady) {
    return;
  }

  if (!initPromise) {
    // Chemin absolu vers public/ — évite les problèmes de résolution de import.meta.url dans les workers
    initPromise = init({ module_or_path: '/redviewalgo_bg.wasm' }).then(
      () => {
        wasmReady = true;
      },
      (error: unknown) => {
        // Échec réseau / 502 pendant un déploiement : ne pas garder la
        // promesse rejetée, sinon le worker échoue jusqu'au rechargement.
        initPromise = null;
        throw error;
      },
    );
  }

  await initPromise;
}

self.onmessage = async (event: MessageEvent<FitWorkerRequest>) => {
  const message = event.data;

  try {
    await ensureInit();

    switch (message.type) {
      case 'predict': {
        const fitArrays = message.fitFiles.map((buffer) => new Uint8Array(buffer));
        const gpxArray = new Uint8Array(message.gpxData);
        const onProgress = (text: string) => {
          respond({
            _id: message._id,
            type: 'progress',
            action: 'predict',
            message: text,
          });
        };
        const result = predict(fitArrays, gpxArray, message.config ?? {}, onProgress);
        respond({ _id: message._id, type: 'result', action: 'predict', data: result });
        break;
      }

      case 'predictRun': {
        const fitArrays = message.fitFiles.map((buffer) => new Uint8Array(buffer));
        const gpxArray = new Uint8Array(message.gpxData);
        const onProgress = (text: string) => {
          respond({
            _id: message._id,
            type: 'progress',
            action: 'predictRun',
            message: text,
          });
        };
        const result = predict_run(fitArrays, gpxArray, message.config, onProgress);
        respond({ _id: message._id, type: 'result', action: 'predictRun', data: result });
        break;
      }

      case 'compare': {
        const fitArrays = message.fitFiles.map((buffer) => new Uint8Array(buffer));
        const validationArray = new Uint8Array(message.validationFit);
        const result = predict_vs_actual(fitArrays, validationArray, message.config ?? {});
        respond({ _id: message._id, type: 'result', action: 'compare', data: result });
        break;
      }

      case 'calibrateCycling': {
        const fitArrays = message.fitFiles.map((buffer) => new Uint8Array(buffer));
        const onProgress = (text: string) => {
          respond({ _id: message._id, type: 'progress', action: 'calibrateCycling', message: text });
        };
        const result = calibrate_cycling(fitArrays, message.config, onProgress);
        respond({ _id: message._id, type: 'result', action: 'calibrateCycling', data: result });
        break;
      }

      case 'predictCycling': {
        const { route } = message;
        const result = predict_cycling(
          route.lat,
          route.lon,
          route.ele,
          route.dist,
          route.surface,
          route.way,
          route.headwind,
          message.config,
        );
        respond({ _id: message._id, type: 'result', action: 'predictCycling', data: result });
        break;
      }
    }
  } catch (error: unknown) {
    const messageText = error instanceof Error ? error.message : String(error);
    respond({ _id: message._id, type: 'error', message: messageText });
  }
};

function respond(message: FitWorkerResponse): void {
  self.postMessage(message);
}