/// <reference lib="webworker" />

import { parseLazBuffer } from '../lib/lazParser';
import { colorizePointCloud, prefetchOrthoTiles } from '../lib/colorizer';

import type { CopcHierarchyInfo, DetectedCrs, PointCloudBounds, PointCloudOrigin } from '../types';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type WorkerRequest =
  | {
      type: 'process';
      buffer: ArrayBuffer;
      crs?: DetectedCrs;
      wasmModule?: WebAssembly.Module;
      redviewLazModule?: WebAssembly.Module | null;
    }
  /** Start ortho downloads early (from header bounds) while points decode elsewhere. */
  | { type: 'prefetch'; bounds: PointCloudBounds; crs: DetectedCrs }
  /** Colorize already-decoded points (parallel COPC decode path). */
  | {
      type: 'colorize';
      positions: Float32Array;
      classifications: Uint8Array;
      count: number;
      bounds: PointCloudBounds;
      origin: PointCloudOrigin;
      crs: DetectedCrs;
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
      origin: PointCloudOrigin;
      crs: string;
      intensities?: Uint16Array;
      copc?: CopcHierarchyInfo;
    }
  | { type: 'error'; message: string };

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const request = e.data;
  if (request.type === 'prefetch') {
    try {
      prefetchOrthoTiles(request.bounds, request.crs);
    } catch {
      // Prefetch is best-effort; colorize fetches whatever is missing.
    }
    return;
  }

  try {
    const pointCloud = request.type === 'process'
      ? await parseLazBuffer(
          request.buffer,
          (phase, pct) => {
            const msg: WorkerResponse = { type: 'progress', phase: 'parsing', message: phase, percent: pct };
            workerScope.postMessage(msg);
          },
          request.crs,
          request.wasmModule,
          request.redviewLazModule,
        )
      : {
          positions: request.positions,
          colors: new Uint8Array(request.count * 3),
          classifications: request.classifications,
          count: request.count,
          bounds: request.bounds,
          origin: request.origin,
          crs: request.crs,
        };

    // Files with their own RGB (PDRF 7/8) skip the orthophoto pass.
    if (!pointCloud.embeddedRgb) {
      await colorizePointCloud(pointCloud, (phase, pct) => {
        const msg: WorkerResponse = { type: 'progress', phase: 'colorizing', message: phase, percent: pct };
        workerScope.postMessage(msg);
      });
    }

    const result: WorkerResponse = {
      type: 'done',
      positions: pointCloud.positions,
      colors: pointCloud.colors,
      classifications: pointCloud.classifications,
      count: pointCloud.count,
      bounds: pointCloud.bounds,
      origin: pointCloud.origin,
      crs: pointCloud.crs,
      intensities: pointCloud.intensities,
      copc: pointCloud.copc,
    };
    const transfer: Transferable[] = [
      pointCloud.positions.buffer,
      pointCloud.colors.buffer,
      pointCloud.classifications.buffer,
    ];
    if (pointCloud.intensities) transfer.push(pointCloud.intensities.buffer);
    workerScope.postMessage(result, transfer);
  } catch (err) {
    const msg: WorkerResponse = { type: 'error', message: (err instanceof Error && err.message) || String(err) };
    workerScope.postMessage(msg);
  }
};
