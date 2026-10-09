import type { GpxRoute } from '../types';
import { decodeGpxBytes, GpxParseError, parseGpxText, type GpxParseErrorCode } from './gpx-parse';

interface GpxParseWorkerRequest {
  file: File;
}

interface GpxParseWorkerSuccess {
  ok: true;
  route: GpxRoute;
}

interface GpxParseWorkerFailure {
  ok: false;
  message: string;
  /** Refus motivé du fichier (et non plantage de l'analyseur). */
  code?: GpxParseErrorCode;
}

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<GpxParseWorkerRequest>) => {
  try {
    const bytes = new Uint8Array(await event.data.file.arrayBuffer());
    const route = parseGpxText(decodeGpxBytes(bytes));
    const response: GpxParseWorkerSuccess = { ok: true, route };
    workerScope.postMessage(response);
  } catch (error) {
    const response: GpxParseWorkerFailure = {
      ok: false,
      message: error instanceof Error ? error.message : 'Impossible de lire ce GPX',
      ...(error instanceof GpxParseError ? { code: error.code } : {}),
    };
    workerScope.postMessage(response);
  }
};

export {};
