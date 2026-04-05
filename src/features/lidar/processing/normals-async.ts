import NormalsWorker from './normals-worker?worker';

export function estimateNormalsAsync(
  positions: Float32Array,
  count: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new NormalsWorker();
    worker.onmessage = (e: MessageEvent<{ normals: Float32Array }>) => {
      resolve(e.data.normals);
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
    worker.postMessage({ positions, count }, [positions.buffer]);
  });
}
