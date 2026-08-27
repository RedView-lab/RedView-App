// ============================================
// LiDAR HD — WebGL fallback Terrain Worker
// ============================================
// Parses the LAZ (no orthophoto colorisation needed — colours come from a
// stitched ortho texture sampled in the fragment shader) and builds a high
// resolution textured heightmap mesh.
//
// Resolution target = 2× the WebGPU pipeline (MAX_GRID 1024 vs 512). The
// per-vertex output is { pos:vec3, normal:vec3, uv:vec2 } so the renderer
// can sample the orthophoto with linear filtering for crisp pixels (no
// per-cell colour averaging).

import { parseLazBuffer } from '../lib/lazParser';
import type { PointCloudBounds } from '../types';

export interface CornerUV {
  u00: number; v00: number; // (minX, minY)
  u10: number; v10: number; // (maxX, minY)
  u01: number; v01: number; // (minX, maxY)
  u11: number; v11: number; // (maxX, maxY)
}

export interface TerrainMeshWebGL {
  vertices: Float32Array;   // pos.xyz | normal.xyz | uv.xy → 8 floats / vertex
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  bounds: PointCloudBounds;
  centerX: number;
  centerY: number;
  centerZ: number;
  extent: number;
  gridWidth: number;
  gridHeight: number;
  /** Per-cell ground height in metres, row-major SOUTH→NORTH. Same data the
   *  snow pipeline (runSnowPipeline) needs as input — we transfer it back
   *  so the WebGL viewer can light up snow without re-parsing the LAZ. */
  heightGrid: Float32Array;
}

type WorkerInput = {
  type: 'build';
  buffer?: ArrayBuffer;
  buffers?: ArrayBuffer[];
  bounds?: PointCloudBounds;
  cornerUV: CornerUV;
  /** Hard cap on grid side (vertices). Caller picks per device tier. */
  maxGrid?: number;
  /** Floor on cell size in metres. Caller picks per device tier. */
  minResM?: number;
};

type WorkerOutput =
  | { type: 'progress'; phase: string; percent: number }
  | { type: 'done'; mesh: TerrainMeshWebGL }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
// Defaults if the caller does not specify a tier. 2048 = 4× the WebGPU
// pipeline (which is 512). The caller should normally pass an explicit
// maxGrid based on detected device capability.
const DEFAULT_MAX_GRID = 2048;
const DEFAULT_MIN_RES_M = 0.25;
const MAX_HOLE_DIST = 14;

scope.onmessage = async (e: MessageEvent<WorkerInput>) => {
  if (e.data.type !== 'build') return;
  try {
    const { buffer, buffers, bounds: customBounds, cornerUV, maxGrid, minResM } = e.data;
    const rawBuffers: ArrayBuffer[] = buffers && buffers.length > 0
      ? buffers
      : (buffer ? [buffer] : []);

    if (rawBuffers.length === 0) {
      throw new Error('Aucun buffer LAZ transmis au worker de terrain WebGL.');
    }

    const gridCap = clampInt(maxGrid ?? DEFAULT_MAX_GRID, 64, 4096);
    const resFloor = Math.max(0.05, minResM ?? DEFAULT_MIN_RES_M);

    const pointClouds: Array<{
      positions: Float32Array;
      classifications: Uint8Array;
      count: number;
      bounds: PointCloudBounds;
    }> = [];

    const totalBuffers = rawBuffers.length;
    for (let i = 0; i < totalBuffers; i++) {
      const buf = rawBuffers[i]!;
      const pc = await parseLazBuffer(buf, (phase, pct) => {
        const slicePct = (i + pct) / totalBuffers;
        post({ type: 'progress', phase: `LAZ (${i + 1}/${totalBuffers}) : ${phase}`, percent: slicePct * 0.55 });
      });
      pointClouds.push({
        positions: pc.positions,
        classifications: pc.classifications,
        count: pc.count,
        bounds: pc.bounds,
      });
    }

    post({ type: 'progress', phase: 'Construction du terrain HD…', percent: 60 });

    const combinedBounds: PointCloudBounds = customBounds ?? {
      minX: Math.min(...pointClouds.map((pc) => pc.bounds.minX)),
      minY: Math.min(...pointClouds.map((pc) => pc.bounds.minY)),
      minZ: Math.min(...pointClouds.map((pc) => pc.bounds.minZ)),
      maxX: Math.max(...pointClouds.map((pc) => pc.bounds.maxX)),
      maxY: Math.max(...pointClouds.map((pc) => pc.bounds.maxY)),
      maxZ: Math.max(...pointClouds.map((pc) => pc.bounds.maxZ)),
    };

    const mesh = buildTerrain(
      pointClouds,
      combinedBounds,
      cornerUV,
      gridCap,
      resFloor,
      (pct) => post({ type: 'progress', phase: 'Maillage HD…', percent: 60 + pct * 0.4 }),
    );

    post(
      { type: 'done', mesh },
      [mesh.vertices.buffer, mesh.indices.buffer, mesh.heightGrid.buffer],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message });
  }
};

function post(msg: WorkerOutput, transfer?: Transferable[]) {
  if (transfer && transfer.length) scope.postMessage(msg, transfer);
  else scope.postMessage(msg);
}

function buildTerrain(
  pointClouds: Array<{
    positions: Float32Array;
    classifications: Uint8Array;
    count: number;
    bounds: PointCloudBounds;
  }>,
  bounds: PointCloudBounds,
  cornerUV: CornerUV,
  maxGrid: number,
  minResM: number,
  onProgress: (pct: number) => void,
): TerrainMeshWebGL {
  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;

  // Cell size: max( min res, range / maxGrid )
  const res = Math.max(minResM, rangeX / maxGrid, rangeY / maxGrid);
  const gridW = Math.max(2, Math.min(maxGrid + 1, Math.ceil(rangeX / res) + 1));
  const gridH = Math.max(2, Math.min(maxGrid + 1, Math.ceil(rangeY / res) + 1));
  const N = gridW * gridH;

  // 1) First pass: count ground points to decide fallback
  let totalCount = 0;
  let groundCount = 0;
  for (const pc of pointClouds) {
    totalCount += pc.count;
    for (let i = 0; i < pc.count; i++) {
      const cls = pc.classifications[i];
      if (cls === 2 || cls === 9 || cls === 17) groundCount++;
    }
  }
  const useStrictGround = groundCount >= Math.min(1000, totalCount * 0.05);

  // 2) Bilinear splatting accumulation grid (completely eliminates flight-line stepping and moiré beating)
  const sumZ = new Float64Array(N);
  const sumW = new Float32Array(N);
  const hasPoint = new Uint8Array(N);

  for (const pc of pointClouds) {
    const { positions, classifications, count } = pc;
    for (let i = 0; i < count; i++) {
      const cls = classifications[i];
      if (useStrictGround) {
        if (cls !== 2 && cls !== 9 && cls !== 17) continue;
      } else {
        if (cls === 7 || cls === 18) continue; // ignore noise
      }

      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];

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

        sumZ[i00] += z * w00; sumW[i00] += w00; hasPoint[i00] = 1;
        sumZ[i10] += z * w10; sumW[i10] += w10; hasPoint[i10] = 1;
        sumZ[i01] += z * w01; sumW[i01] += w01; hasPoint[i01] = 1;
        sumZ[i11] += z * w11; sumW[i11] += w11; hasPoint[i11] = 1;
      }
    }
  }

  const heights = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (sumW[i] > 0) {
      heights[i] = sumZ[i] / sumW[i];
    } else {
      heights[i] = Infinity;
    }
  }
  onProgress(0.25);

  // 3) Initial distance BFS fill for large gaps
  fillHoles(heights, gridW, gridH);
  onProgress(0.40);

  // Global fallback for fully empty tiles
  let globalMinZ = Infinity;
  for (let i = 0; i < N; i++) if (heights[i] < globalMinZ) globalMinZ = heights[i];
  if (!isFinite(globalMinZ)) globalMinZ = bounds.minZ;
  for (let i = 0; i < N; i++) if (!isFinite(heights[i])) heights[i] = globalMinZ;

  // 4) Harmonic Laplace relaxation on unmeasured cells (smooth C2 boundary blending without altering real points)
  relaxHolesLaplacian(heights, hasPoint, gridW, gridH, 20);
  onProgress(0.65);

  // 5) Build interleaved VBO (pos.xyz | normal.xyz | uv.xy) with 100% crisp raw LiDAR elevations
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const Z_OFFSET = -0.05;

  const FLOATS_PER_VERTEX = 8;
  const vertices = new Float32Array(N * FLOATS_PER_VERTEX);

  for (let gy = 0; gy < gridH; gy++) {
    const fy = gridH > 1 ? gy / (gridH - 1) : 0;
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * FLOATS_PER_VERTEX;
      const fx = gridW > 1 ? gx / (gridW - 1) : 0;

      const lx = bounds.minX + fx * rangeX;
      const ly = bounds.minY + fy * rangeY;
      const lz = heights[idx] + Z_OFFSET;

      // Renderer space: X east, Y up, Z south (matches the WebGPU viewer).
      vertices[vi + 0] = lx - cx;
      vertices[vi + 1] = lz - cz;
      vertices[vi + 2] = -(ly - cy);

      // Bilinear-interp UV from the 4 corner pixel anchors.
      const fx1 = 1 - fx, fy1 = 1 - fy;
      const u = fx1 * fy1 * cornerUV.u00 + fx * fy1 * cornerUV.u10
              + fx1 * fy  * cornerUV.u01 + fx * fy  * cornerUV.u11;
      const v = fx1 * fy1 * cornerUV.v00 + fx * fy1 * cornerUV.v10
              + fx1 * fy  * cornerUV.v01 + fx * fy  * cornerUV.v11;
      vertices[vi + 6] = u;
      vertices[vi + 7] = v;
    }
  }
  onProgress(0.75);

  // 6) Per-vertex normal from Horn's 8-neighbor weighted slope gradient (GIS industry standard)
  for (let gy = 0; gy < gridH; gy++) {
    const y0 = Math.max(0, gy - 1);
    const y1 = gy;
    const y2 = Math.min(gridH - 1, gy + 1);

    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * FLOATS_PER_VERTEX;

      const x0 = Math.max(0, gx - 1);
      const x1 = gx;
      const x2 = Math.min(gridW - 1, gx + 1);

      // 8 neighboring elevation samples
      const z00 = heights[y0 * gridW + x0];
      const z10 = heights[y0 * gridW + x1];
      const z20 = heights[y0 * gridW + x2];

      const z01 = heights[y1 * gridW + x0];
      const z21 = heights[y1 * gridW + x2];

      const z02 = heights[y2 * gridW + x0];
      const z12 = heights[y2 * gridW + x1];
      const z22 = heights[y2 * gridW + x2];

      // Horn's 8-neighbor gradient formula:
      // dz/dx = ((z20 + 2*z21 + z22) - (z00 + 2*z01 + z02)) / (8 * res)
      // dz/dy = ((z02 + 2*z12 + z22) - (z00 + 2*z10 + z20)) / (8 * res)
      const scaleX = (x2 === x0) ? (2 * res) : (x2 - x0) * 4 * res;
      const scaleY = (y2 === y0) ? (2 * res) : (y2 - y0) * 4 * res;

      const dzdx = ((z20 + 2 * z21 + z22) - (z00 + 2 * z01 + z02)) / Math.max(0.0001, scaleX);
      const dzdy = ((z02 + 2 * z12 + z22) - (z00 + 2 * z10 + z20)) / Math.max(0.0001, scaleY);

      // Y up → ground normal = (-dz/dx, 1, +dz/dy) in renderer space
      let nx = -dzdx, ny = 1.0, nz = dzdy;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      vertices[vi + 3] = nx / len;
      vertices[vi + 4] = ny / len;
      vertices[vi + 5] = nz / len;
    }
  }
  onProgress(0.9);

  // 7) Indices (two triangles / quad)
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
  onProgress(1);

  const extent = Math.max(rangeX, rangeY, bounds.maxZ - bounds.minZ);
  return {
    vertices,
    indices,
    vertexCount: N,
    indexCount,
    bounds,
    centerX: cx,
    centerY: cy,
    centerZ: cz,
    extent,
    gridWidth: gridW,
    gridHeight: gridH,
    heightGrid: heights,
  };
}

/**
 * Initial BFS distance-based flood fill to ensure every cell has an initial value.
 */
function fillHoles(heights: Float32Array, w: number, h: number): void {
  const N = w * h;
  const dist = new Uint32Array(N).fill(0xFFFFFFFF);
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  const deltas: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  // Seed: every filled cell adjacent to an empty one
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!isFinite(heights[idx])) continue;
      dist[idx] = 0;
      let frontier = false;
      for (const [dx, dy] of deltas) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !isFinite(heights[ny * w + nx])) {
          frontier = true; break;
        }
      }
      if (frontier) queue[tail++] = idx;
    }
  }

  while (head < tail) {
    const src = queue[head++];
    const sx = src % w;
    const sy = (src / w) | 0;
    const newD = dist[src] + 1;
    if (newD > MAX_HOLE_DIST) continue;
    for (const [dx, dy] of deltas) {
      const nx = sx + dx, ny = sy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== 0xFFFFFFFF) continue;
      heights[ni] = heights[src];
      dist[ni] = newD;
      queue[tail++] = ni;
    }
  }
}

/**
 * Smooths unfilled cells using Laplacian harmonic relaxation (Poisson PDE)
 * to eliminate staircases and scanline gaps while strictly preserving measured points.
 * Pre-indexes hole cells to avoid scanning millions of measured vertices on each iteration.
 */
function relaxHolesLaplacian(
  heights: Float32Array,
  hasPoint: Uint8Array,
  w: number,
  h: number,
  iterations = 20,
): void {
  const N = w * h;
  let holeCount = 0;
  for (let i = 0; i < N; i++) {
    if (hasPoint[i] === 0) holeCount++;
  }
  if (holeCount === 0) return; // No holes to relax

  const holeIndices = new Uint32Array(holeCount);
  let hIdx = 0;
  for (let i = 0; i < N; i++) {
    if (hasPoint[i] === 0) holeIndices[hIdx++] = i;
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < holeCount; i++) {
      const idx = holeIndices[i]!;
      const x = idx % w;
      const y = (idx / w) | 0;

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

function clampInt(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export type TerrainWorkerInput = WorkerInput;
export type TerrainWorkerOutput = WorkerOutput;
