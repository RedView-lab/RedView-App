import {
  encodeProjectPayload,
  type EncodedProjectPayload,
  type PayloadWorkerRequest,
  type PayloadWorkerResponse,
} from './payloadEncoding';

// Runs encodeProjectPayload in one shared worker (payloadWorker.ts), the page
// as a fallback (no Worker, worker failed to load or crashed).

interface PendingEncode {
  resolve: (value: EncodedProjectPayload) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, PendingEncode>();

function payloadWorker(): Worker | null {
  if (worker || workerBroken || typeof Worker === 'undefined') return worker;
  try {
    const created = new Worker(new URL('./payloadWorker.ts', import.meta.url), { type: 'module' });
    created.onmessage = (event: MessageEvent<PayloadWorkerResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if ('error' in event.data) request.reject(new Error(event.data.error));
      else request.resolve({ data: event.data.data, gzip: event.data.gzip, compressed: event.data.compressed });
    };
    created.onerror = (event) => {
      // A worker that cannot load or crashed: every request falls back to the page.
      workerBroken = true;
      worker = null;
      created.terminate();
      for (const request of pending.values()) request.reject(new Error(event.message || 'payload worker failed'));
      pending.clear();
    };
    worker = created;
  } catch {
    workerBroken = true;
  }
  return worker;
}

/**
 * Gzip + base64 of a project document in a worker: on a 16 M-character
 * project they blocked the page 0.85–1.3 s per autosave (tasks up to 0.76 s,
 * Edge 2026-10-07) — every 4 s while editing. The page only posts the JSON
 * string (a copy, no object graph to clone). Same result as in the page.
 */
export async function encodeProjectPayloadOffThread(json: string): Promise<EncodedProjectPayload> {
  const target = payloadWorker();
  if (!target) return encodeProjectPayload(json);
  const id = nextId++;
  try {
    return await new Promise<EncodedProjectPayload>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.postMessage({ id, json } satisfies PayloadWorkerRequest);
    });
  } catch {
    return encodeProjectPayload(json);
  }
}
