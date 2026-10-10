import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CyclingRouteInput, FitWorkerRequest, FitWorkerResponse } from '../types';

import { createFitPredictionEngine } from './api';

/** Faux worker : répond ce que le test lui fait répondre. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<FitWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly received: FitWorkerRequest[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: FitWorkerRequest): void {
    this.received.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: FitWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<FitWorkerResponse>);
  }
}

const route: CyclingRouteInput = {
  lat: new Float64Array(2),
  lon: new Float64Array(2),
  ele: new Float64Array(2),
  dist: new Float64Array(0),
  surface: new Uint8Array(0),
  way: new Uint8Array(0),
  headwind: new Float64Array(0),
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe('moteur de prédiction : panique WASM (F1-1)', () => {
  it('remplace le worker après une erreur fatale au lieu de garder une instance WASM empoisonnée', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const engine = createFitPredictionEngine();
    const first = FakeWorker.instances[0]!;

    const failed = engine.predictCycling(route, {} as never);
    first.reply({ _id: first.received[0]!._id, type: 'error', message: 'unreachable', fatal: true });
    await expect(failed).rejects.toThrow('Le moteur de prédiction a rencontré une erreur interne');
    expect(first.terminated).toBe(true);

    // Calcul suivant : un worker neuf (nouvelle instance WASM).
    const next = engine.predictCycling(route, {} as never);
    const second = FakeWorker.instances[1]!;
    expect(second).toBeDefined();
    expect(second.received).toHaveLength(1);
    second.reply({ _id: second.received[0]!._id, type: 'result', action: 'predictCycling', data: { total_time_s: 1 } as never });
    await expect(next).resolves.toMatchObject({ total_time_s: 1 });
  });

  it('garde le worker après une erreur ordinaire (fichier refusé)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const engine = createFitPredictionEngine();
    const first = FakeWorker.instances[0]!;

    const failed = engine.predictCycling(route, {} as never);
    first.reply({ _id: first.received[0]!._id, type: 'error', message: 'Error parsing FIT file #1' });
    await expect(failed).rejects.toThrow('Error parsing FIT file #1');
    expect(first.terminated).toBe(false);
    void engine.predictCycling(route, {} as never);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(first.received).toHaveLength(2);
  });
});
