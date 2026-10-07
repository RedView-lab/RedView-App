/**
 * Points per decode batch: a batch is posted to the page as soon as it is
 * decoded, so this bounds what a decode worker holds at once (its WASM memory
 * never shrinks) — 1 M points ≈ 15 MB of decoded arrays.
 */
const COPC_DECODE_BATCH_POINTS = 1_000_000;

/**
 * Splits chunks, in order, into runs of whole chunks of at most
 * `maxPoints` points (a chunk bigger than that is a batch on its own).
 */
export function splitChunkBatches<T extends { pointCount: number }>(
  chunks: readonly T[],
  maxPoints = COPC_DECODE_BATCH_POINTS,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let points = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && points + chunk.pointCount > maxPoints) {
      batches.push(current);
      current = [];
      points = 0;
    }
    current.push(chunk);
    points += chunk.pointCount;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
