// ============================================================================
// Snow redistribution — Web Worker
// ============================================================================
//
// Reçoit l'input pipeline, exécute le calcul, renvoie progress + résultat.

import { computeSnowRedistribution, type RedistributeInput, type RedistributeOutput } from './redistribute';

interface WorkerInMsg {
  type: 'compute';
  payload: {
    aromeData: ArrayBuffer;
    aromeW: number;
    aromeH: number;
    aromeBounds: [number, number, number, number];
    heightmap: ArrayBuffer;
    terrainW: number;
    terrainH: number;
    terrainOrigin: [number, number];
    terrainSize: [number, number];
    config: RedistributeInput['config'];
  };
}

interface WorkerOutMsg {
  type: 'progress' | 'done' | 'error';
  pct?: number;
  label?: string;
  result?: { data: ArrayBuffer; width: number; height: number; meanCm: number; maxCm: number; coveragePct: number };
  message?: string;
}

self.onmessage = (e: MessageEvent<WorkerInMsg>) => {
  if (e.data.type !== 'compute') return;
  const p = e.data.payload;
  try {
    const input: RedistributeInput = {
      aromeData: new Float32Array(p.aromeData),
      aromeW: p.aromeW,
      aromeH: p.aromeH,
      aromeBounds: p.aromeBounds,
      heightmap: new Float32Array(p.heightmap),
      terrainW: p.terrainW,
      terrainH: p.terrainH,
      terrainOrigin: p.terrainOrigin,
      terrainSize: p.terrainSize,
      config: p.config,
    };
    const out: RedistributeOutput = computeSnowRedistribution(input, (pct, label) => {
      const msg: WorkerOutMsg = { type: 'progress', pct, label };
      (self as unknown as Worker).postMessage(msg);
    });
    const result: WorkerOutMsg = {
      type: 'done',
      result: {
        data: out.data.buffer as ArrayBuffer,
        width: out.width,
        height: out.height,
        meanCm: out.meanCm,
        maxCm: out.maxCm,
        coveragePct: out.coveragePct,
      },
    };
    (self as unknown as Worker).postMessage(result, [out.data.buffer as ArrayBuffer]);
  } catch (err) {
    const msg: WorkerOutMsg = { type: 'error', message: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(msg);
  }
};

export {};
