import { estimateNormals } from './normal-estimator';

self.onmessage = (e: MessageEvent<{ positions: Float32Array; count: number }>) => {
  const { positions, count } = e.data;
  const normals = estimateNormals(positions, count);
  (self as unknown as Worker).postMessage({ normals }, [normals.buffer]);
};
