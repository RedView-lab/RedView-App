/**
 * Points par lot de décodage : un lot est envoyé à la page dès qu'il est
 * décodé, ce qui borne ce qu'un worker de décodage garde à la fois (sa mémoire
 * WASM ne rétrécit jamais) — 1 M points ≈ 15 Mo de tableaux décodés.
 */
const COPC_DECODE_BATCH_POINTS = 1_000_000;

/**
 * Découpe les chunks, dans l'ordre, en séries de chunks entiers d'au plus
 * `maxPoints` points (un chunk plus gros forme un lot à lui seul).
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
