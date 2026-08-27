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

const MAX_HOLE_DIST = 16;
const DEFAULT_MAX_GRID = 1024;
const DEFAULT_MIN_RES_M = 0.5;

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

  const maxGrid = DEFAULT_MAX_GRID;
  const minResM = Math.max(0.25, Math.min(resolution || DEFAULT_MIN_RES_M, DEFAULT_MIN_RES_M));
  const res = Math.max(minResM, rangeX / maxGrid, rangeY / maxGrid);

  const gridW = Math.max(2, Math.min(maxGrid + 1, Math.ceil(rangeX / res) + 1));
  const gridH = Math.max(2, Math.min(maxGrid + 1, Math.ceil(rangeY / res) + 1));
  const N = gridW * gridH;

  // 1) First pass: count ground points to decide fallback
  let groundCount = 0;
  for (let i = 0; i < count; i++) {
    const cls = classifications[i];
    if (cls === 2 || cls === 9 || cls === 17) groundCount++;
  }
  const useStrictGround = groundCount >= Math.min(1000, count * 0.05);

  // 2) Bilinear splatting accumulation grid (completely eliminates flight-line stepping and moiré beating)
  const sumZ = new Float64Array(N);
  const sumW = new Float32Array(N);
  const sumR = new Float64Array(N);
  const sumG = new Float64Array(N);
  const sumB = new Float64Array(N);
  const hasPoint = new Uint8Array(N);

  for (let i = 0; i < count; i++) {
    const cls = classifications[i];
    if (useStrictGround) {
      if (cls !== 2 && cls !== 9 && cls !== 17) continue;
    } else {
      if (cls === 7 || cls === 18) continue; // ignore noise
    }

    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;

    const r = colors[i * 3]!;
    const g = colors[i * 3 + 1]!;
    const b = colors[i * 3 + 2]!;

    const gx = (x - bounds.minX) / res;
    const gy = (y - bounds.minY) / res;

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;

    if (x0 >= 0 && x0 < gridW - 1 && y0 >= 0 && y0 < gridH - 1) {
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = y0 * gridW + x0;
      const i10 = y0 * gridW + (x0 + 1);
      const i01 = (y0 + 1) * gridW + x0;
      const i11 = (y0 + 1) * gridW + (x0 + 1);

      sumZ[i00] += z * w00; sumW[i00] += w00; sumR[i00] += r * w00; sumG[i00] += g * w00; sumB[i00] += b * w00; hasPoint[i00] = 1;
      sumZ[i10] += z * w10; sumW[i10] += w10; sumR[i10] += r * w10; sumG[i10] += g * w10; sumB[i10] += b * w10; hasPoint[i10] = 1;
      sumZ[i01] += z * w01; sumW[i01] += w01; sumR[i01] += r * w01; sumG[i01] += g * w01; sumB[i01] += b * w01; hasPoint[i01] = 1;
      sumZ[i11] += z * w11; sumW[i11] += w11; sumR[i11] += r * w11; sumG[i11] += g * w11; sumB[i11] += b * w11; hasPoint[i11] = 1;
    }
  }

  const heights = new Float32Array(N);
  const colR = new Uint8Array(N);
  const colG = new Uint8Array(N);
  const colB = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (sumW[i]! > 0) {
      heights[i] = sumZ[i]! / sumW[i]!;
      colR[i] = Math.round(sumR[i]! / sumW[i]!);
      colG[i] = Math.round(sumG[i]! / sumW[i]!);
      colB[i] = Math.round(sumB[i]! / sumW[i]!);
    } else {
      heights[i] = Infinity;
      colR[i] = 128;
      colG[i] = 128;
      colB[i] = 128;
    }
  }

  // 3) Initial distance BFS fill for large gaps
  fillHoles(heights, colR, colG, colB, gridW, gridH);

  // Global fallback for fully empty tiles
  let globalMinZ = Infinity;
  for (let i = 0; i < N; i++) {
    if (heights[i]! < globalMinZ) globalMinZ = heights[i]!;
  }
  if (!isFinite(globalMinZ)) globalMinZ = bounds.minZ;
  for (let i = 0; i < N; i++) {
    if (!isFinite(heights[i]!)) heights[i] = globalMinZ;
  }

  // 4) Harmonic Laplace relaxation on unmeasured cells (smooth C2 boundary blending without altering real points)
  relaxHolesLaplacian(heights, hasPoint, gridW, gridH, 20);

  // 5) Build mesh in renderer space
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const Z_OFFSET = -0.05;

  const vertexCount = N;
  const vertices = new Float32Array(vertexCount * 6);
  const meshColors = new Uint8Array(vertexCount * 4);

  for (let gy = 0; gy < gridH; gy++) {
    const fy = gridH > 1 ? gy / (gridH - 1) : 0;
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * 6;
      const fx = gridW > 1 ? gx / (gridW - 1) : 0;

      const lx = bounds.minX + fx * rangeX;
      const ly = bounds.minY + fy * rangeY;
      const lz = heights[idx]! + Z_OFFSET;

      vertices[vi + 0] = lx - cx;
      vertices[vi + 1] = lz - cz;
      vertices[vi + 2] = -(ly - cy);

      const ci = idx * 4;
      meshColors[ci + 0] = colR[idx]!;
      meshColors[ci + 1] = colG[idx]!;
      meshColors[ci + 2] = colB[idx]!;
      meshColors[ci + 3] = 255;
    }
  }

  // 6) Per-vertex normal from Horn's 8-neighbor weighted slope gradient (GIS industry standard)
  for (let gy = 0; gy < gridH; gy++) {
    const y0 = Math.max(0, gy - 1);
    const y1 = gy;
    const y2 = Math.min(gridH - 1, gy + 1);

    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * 6;

      const x0 = Math.max(0, gx - 1);
      const x1 = gx;
      const x2 = Math.min(gridW - 1, gx + 1);

      // 8 neighboring elevation samples
      const z00 = heights[y0 * gridW + x0]!;
      const z10 = heights[y0 * gridW + x1]!;
      const z20 = heights[y0 * gridW + x2]!;

      const z01 = heights[y1 * gridW + x0]!;
      const z21 = heights[y1 * gridW + x2]!;

      const z02 = heights[y2 * gridW + x0]!;
      const z12 = heights[y2 * gridW + x1]!;
      const z22 = heights[y2 * gridW + x2]!;

      // Horn's 8-neighbor gradient formula
      const scaleX = (x2 === x0) ? (2 * res) : (x2 - x0) * 4 * res;
      const scaleY = (y2 === y0) ? (2 * res) : (y2 - y0) * 4 * res;

      const dzdx = ((z20 + 2 * z21 + z22) - (z00 + 2 * z01 + z02)) / Math.max(0.0001, scaleX);
      const dzdy = ((z02 + 2 * z12 + z22) - (z00 + 2 * z10 + z20)) / Math.max(0.0001, scaleY);

      let nx = -dzdx, ny = 1.0, nz = dzdy;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      vertices[vi + 3] = nx / len;
      vertices[vi + 4] = ny / len;
      vertices[vi + 5] = nz / len;
    }
  }

  // 7) Triangle indices
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

  // Height grid for GPU Sobel / snow / lighting
  const heightGrid = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    heightGrid[i] = vertices[i * 6 + 1]!;
  }

  return { vertices, colors: meshColors, indices, vertexCount, indexCount, heightGrid, gridWidth: gridW, gridHeight: gridH };
}

function fillHoles(
  heights: Float32Array,
  colR: Uint8Array, colG: Uint8Array, colB: Uint8Array,
  w: number, h: number,
): void {
  const N = w * h;
  const dist = new Uint32Array(N).fill(0xFFFFFFFF);
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  const deltas: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!isFinite(heights[idx]!)) continue;
      dist[idx] = 0;
      let frontier = false;
      for (const [dx, dy] of deltas) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !isFinite(heights[ny * w + nx]!)) {
          frontier = true;
          break;
        }
      }
      if (frontier) queue[tail++] = idx;
    }
  }

  while (head < tail) {
    const src = queue[head++]!;
    const sx = src % w;
    const sy = (src / w) | 0;
    const newD = dist[src]! + 1;
    if (newD > MAX_HOLE_DIST) continue;

    for (const [dx, dy] of deltas) {
      const nx = sx + dx, ny = sy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni]! !== 0xFFFFFFFF) continue;

      heights[ni] = heights[src]!;
      colR[ni] = colR[src]!;
      colG[ni] = colG[src]!;
      colB[ni] = colB[src]!;
      dist[ni] = newD;
      queue[tail++] = ni;
    }
  }
}

function relaxHolesLaplacian(
  heights: Float32Array,
  hasPoint: Uint8Array,
  w: number,
  h: number,
  iterations = 20,
): void {
  for (let iter = 0; iter < iterations; iter++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const idx = row + x;
        if (hasPoint[idx] === 1) continue;

        let sum = 0;
        let count = 0;

        if (x > 0) { sum += heights[idx - 1]!; count++; }
        if (x < w - 1) { sum += heights[idx + 1]!; count++; }
        if (y > 0) { sum += heights[idx - w]!; count++; }
        if (y < h - 1) { sum += heights[idx + w]!; count++; }

        if (count > 0) {
          heights[idx] = sum / count;
        }
      }
    }
  }
}
