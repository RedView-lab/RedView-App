export const MAX_BUFFER_POINTS = 50_000_000;

export interface PointChunkBuffers {
  pos: GPUBuffer;
  col: GPUBuffer;
  pointOffset: number;
  count: number;
}

export function computePointChunkCapacity(device: GPUDevice): number {
  const maxBufferSize = device.limits.maxBufferSize;
  return Math.max(
    1,
    Math.min(
      MAX_BUFFER_POINTS,
      Math.floor(maxBufferSize / 12),
      Math.floor(maxBufferSize / 4),
    ),
  );
}

export function destroyPointChunks(chunks: PointChunkBuffers[]): void {
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].pos.destroy();
    chunks[i].col.destroy();
  }
}

export function uploadPointChunks(
  device: GPUDevice,
  pointChunkCapacity: number,
  positions: Float32Array,
  colors: Uint8Array,
): PointChunkBuffers[] {
  const chunks: PointChunkBuffers[] = [];
  const totalPoints = positions.length / 3;

  for (let pointOffset = 0; pointOffset < totalPoints; pointOffset += pointChunkCapacity) {
    const count = Math.min(pointChunkCapacity, totalPoints - pointOffset);

    const pos = device.createBuffer({
      size: count * 12,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(pos.getMappedRange()).set(
      positions.subarray(pointOffset * 3, (pointOffset + count) * 3),
    );
    pos.unmap();

    const col = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Uint8Array(col.getMappedRange()).set(
      colors.subarray(pointOffset * 4, (pointOffset + count) * 4),
    );
    col.unmap();

    chunks.push({ pos, col, pointOffset, count });
  }

  return chunks;
}

export function drawRange(
  pass: GPURenderPassEncoder,
  chunks: PointChunkBuffers[],
  offset: number,
  count: number,
  chunkState: { index: number },
): void {
  let remaining = count;
  let currentOffset = offset;

  while (remaining > 0) {
    const chunkIndex = findChunkIndex(chunks, currentOffset, chunkState.index);
    if (chunkIndex < 0) return;

    const chunk = chunks[chunkIndex];
    if (chunkState.index !== chunkIndex) {
      pass.setVertexBuffer(0, chunk.pos);
      pass.setVertexBuffer(1, chunk.col);
      chunkState.index = chunkIndex;
    }

    const localOffset = currentOffset - chunk.pointOffset;
    if (localOffset < 0 || localOffset >= chunk.count) {
      return;
    }
    const drawCount = Math.min(remaining, chunk.count - localOffset);
    if (drawCount <= 0) {
      return;
    }
    pass.draw(4, drawCount, 0, localOffset);

    currentOffset += drawCount;
    remaining -= drawCount;
  }
}

function findChunkIndex(chunks: PointChunkBuffers[], offset: number, hint: number): number {
  let index = Math.max(0, Math.min(hint, chunks.length - 1));
  if (index > 0 && offset < chunks[index].pointOffset) {
    index = 0;
  }
  while (index < chunks.length) {
    const chunk = chunks[index];
    if (offset >= chunk.pointOffset && offset < chunk.pointOffset + chunk.count) return index;
    index++;
  }
  return -1;
}