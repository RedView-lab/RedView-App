/// <reference lib="webworker" />

import init, { predict, predict_vs_actual } from './pkg/redviewalgo.js';
import type { FitWorkerRequest, FitWorkerResponse } from '../types';

let wasmReady = false;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (wasmReady) {
    return;
  }

  if (!initPromise) {
    initPromise = init().then(() => {
      wasmReady = true;
    });
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

      case 'compare': {
        const fitArrays = message.fitFiles.map((buffer) => new Uint8Array(buffer));
        const validationArray = new Uint8Array(message.validationFit);
        const result = predict_vs_actual(fitArrays, validationArray, message.config ?? {});
        respond({ _id: message._id, type: 'result', action: 'compare', data: result });
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