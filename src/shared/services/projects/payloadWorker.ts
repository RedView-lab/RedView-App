/// <reference lib="webworker" />

// Encodes a project document's cloud payload (gzip, then base64 when it fits
// in the document) off the main thread: see payloadEncoding.ts.

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
