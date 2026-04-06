// ============================================
// Heightmap Terrain Generator — Web Worker
// ============================================

interface WorkerInput {
  type: 'generate';
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  resolution: number;
}

interface HeightmapResult {
  type: 'done';
  vertices: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  if (e.data.type !== 'generate') return;
  const { positions, colors, classifications, count, bounds, resolution } = e.data;
  const result = generateHeightmap(positions, colors, classifications, count, bounds, resolution);
  (self as any).postMessage(
    { type: 'done', ...result } as HeightmapResult,
    [result.vertices.buffer, result.colors.buffer, result.indices.buffer, result.heightGrid.buffer],
  );
};

function generateHeightmap(
  positions: Float32Array,
  colors: Uint8Array,
  classifications: Uint8Array,
  count: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  resolution: number,
) {
  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;

  const MAX_GRID = 512;
  const res = Math.max(0.1, resolution, rangeX / MAX_GRID, rangeY / MAX_GRID);

  const gridW = Math.ceil(rangeX / res) + 1;
  const gridH = Math.ceil(rangeY / res) + 1;
  const N = gridW * gridH;

  const heights = new Float32Array(N).fill(Infinity);
  const colR = new Float64Array(N);
  const colG = new Float64Array(N);
  const colB = new Float64Array(N);
  const cnt = new Uint32Array(N);

  // Ground classes: 2=Ground, 9=Water, 17=Bridge deck
  for (let i = 0; i < count; i++) {
    const cls = classifications[i];
    if (cls !== 2 && cls !== 9 && cls !== 17) continue;

    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const gx = Math.min(gridW - 1, Math.max(0, Math.floor((x - bounds.minX) / res)));
    const gy = Math.min(gridH - 1, Math.max(0, Math.floor((y - bounds.minY) / res)));
    const idx = gy * gridW + gx;

    if (z < heights[idx]) heights[idx] = z;

    colR[idx] += colors[i * 3];
    colG[idx] += colors[i * 3 + 1];
    colB[idx] += colors[i * 3 + 2];
    cnt[idx]++;
  }

  // BFS hole-filling
  fillHoles(heights, colR, colG, colB, cnt, gridW, gridH);

  // Global fallback
  let globalMinZ = Infinity;
  for (let i = 0; i < N; i++) {
    if (heights[i] < globalMinZ) globalMinZ = heights[i];
  }
  if (!isFinite(globalMinZ)) globalMinZ = bounds.minZ;
  for (let i = 0; i < N; i++) {
    if (!isFinite(heights[i])) heights[i] = globalMinZ;
  }

  // Build mesh in renderer space
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const Z_OFFSET = -0.05;

  const vertexCount = N;
  const vertices = new Float32Array(vertexCount * 6);
  const meshColors = new Uint8Array(vertexCount * 4);

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * 6;

      const lx = bounds.minX + (gx + 0.5) * res;
      const ly = bounds.minY + (gy + 0.5) * res;
      const lz = heights[idx] + Z_OFFSET;

      vertices[vi + 0] = lx - cx;
      vertices[vi + 1] = lz - cz;
      vertices[vi + 2] = -(ly - cy);

      const ci = idx * 4;
      if (cnt[idx] > 0) {
        meshColors[ci + 0] = Math.round(colR[idx] / cnt[idx]);
        meshColors[ci + 1] = Math.round(colG[idx] / cnt[idx]);
        meshColors[ci + 2] = Math.round(colB[idx] / cnt[idx]);
      } else {
        meshColors[ci + 0] = 128;
        meshColors[ci + 1] = 128;
        meshColors[ci + 2] = 128;
      }
      meshColors[ci + 3] = 255;
    }
  }

  // Normals from height gradient
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * 6;

      const zL = gx > 0 ? heights[gy * gridW + gx - 1] : heights[idx];
      const zR = gx < gridW - 1 ? heights[gy * gridW + gx + 1] : heights[idx];
      const zD = gy > 0 ? heights[(gy - 1) * gridW + gx] : heights[idx];
      const zU = gy < gridH - 1 ? heights[(gy + 1) * gridW + gx] : heights[idx];

      const scaleX = (gx > 0 && gx < gridW - 1) ? 2 * res : res;
      const scaleY = (gy > 0 && gy < gridH - 1) ? 2 * res : res;

      const dzdx = (zR - zL) / scaleX;
      const dzdy = (zU - zD) / scaleY;

      let nx = -dzdx;
      let ny = 1.0;
      let nz = dzdy;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      vertices[vi + 3] = nx / len;
      vertices[vi + 4] = ny / len;
      vertices[vi + 5] = nz / len;
    }
  }

  // Triangle indices
  const quadW = gridW - 1;
  const quadH = gridH - 1;
  const indexCount = quadW * quadH * 6;
  const indices = new Uint32Array(indexCount);

  let ii = 0;
  for (let gy = 0; gy < quadH; gy++) {
    for (let gx = 0; gx < quadW; gx++) {
      const tl = gy * gridW + gx;
      const tr = tl + 1;
      const bl = tl + gridW;
      const br = bl + 1;

      indices[ii++] = tl;
      indices[ii++] = tr;
      indices[ii++] = bl;

      indices[ii++] = tr;
      indices[ii++] = br;
      indices[ii++] = bl;
    }
  }

  // Height grid for GPU Sobel normal computation
  const heightGrid = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    heightGrid[i] = vertices[i * 6 + 1];
  }

  return { vertices, colors: meshColors, indices, vertexCount, indexCount, heightGrid, gridWidth: gridW, gridHeight: gridH };
}

function fillHoles(
  heights: Float32Array,
  colR: Float64Array, colG: Float64Array, colB: Float64Array,
  cnt: Uint32Array,
  w: number, h: number,
): void {
  const MAX_DIST = 10;
  const N = w * h;
  const dist = new Uint32Array(N).fill(0xFFFFFFFF);
  const queue: number[] = [];
  const deltas: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!isFinite(heights[idx])) continue;
      dist[idx] = 0;
      for (const [dx, dy] of deltas) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !isFinite(heights[ny * w + nx])) {
          queue.push(idx);
          break;
        }
      }
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const src = queue[qi++];
    const sx = src % w;
    const sy = (src / w) | 0;
    const newD = dist[src] + 1;
    if (newD > MAX_DIST) continue;

    for (const [dx, dy] of deltas) {
      const nx = sx + dx, ny = sy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== 0xFFFFFFFF) continue;

      heights[ni] = heights[src];
      colR[ni] = colR[src];
      colG[ni] = colG[src];
      colB[ni] = colB[src];
      cnt[ni] = cnt[src] || 1;
      dist[ni] = newD;
      queue.push(ni);
    }
  }
}
