import {
  encodeProjectPayload,
  type EncodedProjectPayload,
  type PayloadWorkerRequest,
  type PayloadWorkerResponse,
} from './payloadEncoding';

// Exécute encodeProjectPayload dans un worker partagé (payloadWorker.ts), la
// page servant de repli (pas de Worker, worker qui n'a pas pu se charger ou a
// planté).

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
      // Un worker qui ne peut pas se charger ou a planté : chaque requête se replie sur la page.
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
 * Gzip + base64 d'un document de projet dans un worker : sur un projet de 16 M
 * de caractères, ils bloquaient la page 0,85 à 1,3 s par sauvegarde
 * automatique (tâches jusqu'à 0,76 s, Edge 2026-10-07) — toutes les 4 s
 * pendant l'édition. La page n'envoie que la chaîne JSON (une copie, aucun
 * graphe d'objets à cloner). Même résultat que dans la page.
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
