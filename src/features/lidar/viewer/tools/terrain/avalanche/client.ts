// ============================================
// LiDAR viewer tools — avalanche terrain exposure, computed in a worker
// ============================================
//
// One long-lived worker per viewer (it keeps the wind shelter index of the
// scene between clicks). Without workers the same computation runs inline.

import type { AvalancheWorkerRequest, AvalancheWorkerResponse } from '../../../../workers/avalancheWorker';
import { computeAvalancheTerrain, type AvalancheTerrainInput, type AvalancheTerrainResult } from './exposure';
import { WindShelterField } from './releaseArea';

interface PendingRequest {
  resolve: (result: AvalancheTerrainResult | null) => void;
  reject: (error: Error) => void;
}

export class AvalancheComputer {
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private inlineWind: { key: string; field: WindShelterField } | null = null;

  compute(gridKey: string, input: AvalancheTerrainInput): Promise<AvalancheTerrainResult | null> {
    const worker = this.getWorker();
    if (!worker) return Promise.resolve(this.computeInline(gridKey, input));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, gridKey, input } satisfies AvalancheWorkerRequest);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error('Avalanche computation cancelled'));
    this.pending.clear();
  }

  private getWorker(): Worker | null {
    if (this.worker || this.workerFailed) return this.worker;
    try {
      const worker = new Worker(new URL('../../../../workers/avalancheWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<AvalancheWorkerResponse>) => {
        const request = this.pending.get(e.data.id);
        if (!request) return;
        this.pending.delete(e.data.id);
        if (e.data.type === 'done') request.resolve(e.data.result);
        else request.reject(new Error(e.data.message));
      };
      worker.onerror = (event) => {
        console.warn('[LiDAR tools] Avalanche worker failed:', event.message);
        worker.terminate();
        this.worker = null;
        this.workerFailed = true;
        for (const request of this.pending.values()) request.reject(new Error(event.message || 'Avalanche worker failed'));
        this.pending.clear();
      };
      this.worker = worker;
    } catch (error) {
      console.warn('[LiDAR tools] Avalanche worker unavailable, computing inline:', error);
      this.workerFailed = true;
    }
    return this.worker;
  }

  private computeInline(gridKey: string, input: AvalancheTerrainInput): AvalancheTerrainResult | null {
    if (!this.inlineWind || this.inlineWind.key !== gridKey) {
      this.inlineWind = { key: gridKey, field: new WindShelterField(input.grid) };
    }
    return computeAvalancheTerrain(input, this.inlineWind.field);
  }
}
