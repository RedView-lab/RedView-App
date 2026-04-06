// ============================================
// PCA Normal Estimation — Worker Wrapper
// ============================================

export function estimateNormals(
  positions: Float32Array,
  count: number,
  onProgress?: (pct: number) => void,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./normalsWorker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'progress') {
        onProgress?.(e.data.pct);
      } else if (e.data.type === 'done') {
        resolve(e.data.normals as Float32Array);
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };

    const copy = new Float32Array(positions);
    worker.postMessage(
      { type: 'compute', positions: copy, count },
      [copy.buffer],
    );
  });
}
