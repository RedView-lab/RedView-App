import ProcessWorker from './process-worker?worker';
import type { ProcessWorkerOutput } from './process-worker';
import type { PointCloudData } from '../types/tile';

export function processLazAsync(
  buffer: ArrayBuffer,
  onProgress?: (percent: number, phase: string) => void,
): Promise<PointCloudData> {
  return new Promise((resolve, reject) => {
    const worker = new ProcessWorker();
    worker.onmessage = (e: MessageEvent<ProcessWorkerOutput>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.percent, msg.phase);
      } else if (msg.type === 'result') {
        resolve(msg.data);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
    worker.postMessage({ buffer }, [buffer]);
  });
}
