/// <reference lib="webworker" />

import { parseLazBuffer } from './lazParser';
import { colorizePointCloud } from './colorizer';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type WorkerRequest = {
  type: 'process';
  buffer: ArrayBuffer;
};

export type WorkerResponse =
  | { type: 'progress'; phase: string; message: string; percent: number }
  | {
      type: 'done';
      positions: Float32Array;
      colors: Uint8Array;
      classifications: Uint8Array;
      count: number;
      bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
      crs: string;
    }
  | { type: 'error'; message: string };

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type !== 'process') return;

  try {
    const pointCloud = await parseLazBuffer(e.data.buffer, (phase, pct) => {
      const msg: WorkerResponse = { type: 'progress', phase: 'parsing', message: phase, percent: pct };
      workerScope.postMessage(msg);
    });

    await colorizePointCloud(pointCloud, (phase, pct) => {
      const msg: WorkerResponse = { type: 'progress', phase: 'colorizing', message: phase, percent: pct };
      workerScope.postMessage(msg);
    });

    const result: WorkerResponse = {
      type: 'done',
      positions: pointCloud.positions,
      colors: pointCloud.colors,
      classifications: pointCloud.classifications,
      count: pointCloud.count,
      bounds: pointCloud.bounds,
      crs: pointCloud.crs,
    };
    workerScope.postMessage(result, [
      pointCloud.positions.buffer,
      pointCloud.colors.buffer,
      pointCloud.classifications.buffer,
    ]);
  } catch (err: any) {
    const msg: WorkerResponse = { type: 'error', message: err.message || String(err) };
    workerScope.postMessage(msg);
  }
};
