/// <reference lib="webworker" />

// Encode la charge utile cloud d'un document de projet (gzip, puis base64
// quand il tient dans le document) hors du fil principal : voir
// payloadEncoding.ts.

import { encodeProjectPayload, type PayloadWorkerRequest, type PayloadWorkerResponse } from './payloadEncoding';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<PayloadWorkerRequest>) => {
  const { id, json } = event.data;
  try {
    const encoded = await encodeProjectPayload(json);
    workerScope.postMessage(
      { id, ...encoded } satisfies PayloadWorkerResponse,
      encoded.gzip ? [encoded.gzip.buffer] : [],
    );
  } catch (error) {
    workerScope.postMessage({ id, error: (error as Error)?.message || String(error) } satisfies PayloadWorkerResponse);
  }
};
