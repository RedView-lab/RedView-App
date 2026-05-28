import type { GpxRoute } from '../types';
import { parseGpxText } from './gpx-parse';

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
}

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<GpxParseWorkerRequest>) => {
  try {
    const text = await event.data.file.text();
    const route = parseGpxText(text);
    const response: GpxParseWorkerSuccess = { ok: true, route };
    workerScope.postMessage(response);
  } catch (error) {
    const response: GpxParseWorkerFailure = {
      ok: false,
      message: error instanceof Error ? error.message : 'Impossible de lire ce GPX',
    };
    workerScope.postMessage(response);
  }
};

export {};