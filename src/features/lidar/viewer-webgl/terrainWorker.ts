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

import { parseLazBuffer } from '../lazParser';
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
}

type WorkerInput = {
  type: 'build';
  buffer: ArrayBuffer;
  cornerUV: CornerUV;
};

type WorkerOutput =
  | { type: 'progress'; phase: string; percent: number }
  | { type: 'done'; mesh: TerrainMeshWebGL }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const MAX_GRID = 1024;     // 2× the WebGPU pipeline (512)
const MIN_RES_M = 0.5;     // Floor at 0.5 m / cell
const MAX_HOLE_DIST = 14;  // Slightly larger than the WebGPU pipeline (10)

scope.onmessage = async (e: MessageEvent<WorkerInput>) => {
  if (e.data.type !== 'build') return;
  try {
    const { buffer, cornerUV } = e.data;

    // Parse LAZ — same path as WebGPU pipeline. Colours unused.
    const pc = await parseLazBuffer(buffer, (phase, pct) => {
      post({ type: 'progress', phase: `LAZ : ${phase}`, percent: pct * 0.55 });
    });

    post({ type: 'progress', phase: 'Construction du terrain HD…', percent: 60 });

    const mesh = buildTerrain(
      pc.positions, pc.classifications, pc.count, pc.bounds, cornerUV,
      (pct) => post({ type: 'progress', phase: 'Maillage HD…', percent: 60 + pct * 0.4 }),
    );

    post(
      { type: 'done', mesh },
      [mesh.vertices.buffer, mesh.indices.buffer],
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
  positions: Float32Array,
  classifications: Uint8Array,
  count: number,
  bounds: PointCloudBounds,
  cornerUV: CornerUV,
  onProgress: (pct: number) => void,
): TerrainMeshWebGL {
  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;

  // Cell size: max( min res, range / MAX_GRID )
  const res = Math.max(MIN_RES_M, rangeX / MAX_GRID, rangeY / MAX_GRID);
  const gridW = Math.max(2, Math.min(MAX_GRID + 1, Math.ceil(rangeX / res) + 1));
  const gridH = Math.max(2, Math.min(MAX_GRID + 1, Math.ceil(rangeY / res) + 1));
  const N = gridW * gridH;

  const heights = new Float32Array(N).fill(Infinity);

  // 1) Bin lowest ground / water / bridge points into the grid
  for (let i = 0; i < count; i++) {
    const cls = classifications[i];
    if (cls !== 2 && cls !== 9 && cls !== 17) continue;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const gx = clampInt(Math.floor((x - bounds.minX) / res), 0, gridW - 1);
    const gy = clampInt(Math.floor((y - bounds.minY) / res), 0, gridH - 1);
    const idx = gy * gridW + gx;
    if (z < heights[idx]) heights[idx] = z;
  }
  onProgress(0.25);

  // 2) BFS hole-fill so even cells without ground hits get a height
  fillHoles(heights, gridW, gridH);
  onProgress(0.45);

  // 3) Global fallback for fully empty tiles
  let globalMinZ = Infinity;
  for (let i = 0; i < N; i++) if (heights[i] < globalMinZ) globalMinZ = heights[i];
  if (!isFinite(globalMinZ)) globalMinZ = bounds.minZ;
  for (let i = 0; i < N; i++) if (!isFinite(heights[i])) heights[i] = globalMinZ;

  // 4) Build interleaved VBO (pos.xyz | normal.xyz | uv.xy)
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

      // Bilinear-interp UV from the 4 corner pixel anchors. Linear over
      // ~1 km tile is well below 1 px error at z19.
      const fx1 = 1 - fx, fy1 = 1 - fy;
      const u = fx1 * fy1 * cornerUV.u00 + fx * fy1 * cornerUV.u10
              + fx1 * fy  * cornerUV.u01 + fx * fy  * cornerUV.u11;
      const v = fx1 * fy1 * cornerUV.v00 + fx * fy1 * cornerUV.v10
              + fx1 * fy  * cornerUV.v01 + fx * fy  * cornerUV.v11;
      vertices[vi + 6] = u;
      vertices[vi + 7] = v;
    }
  }
  onProgress(0.7);

  // 5) Per-vertex normal from height gradient (Sobel-ish, central diff)
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      const vi = idx * FLOATS_PER_VERTEX;

      const zL = gx > 0          ? heights[idx - 1]      : heights[idx];
      const zR = gx < gridW - 1  ? heights[idx + 1]      : heights[idx];
      const zD = gy > 0          ? heights[idx - gridW]  : heights[idx];
      const zU = gy < gridH - 1  ? heights[idx + gridW]  : heights[idx];

      const sx = (gx > 0 && gx < gridW - 1) ? 2 * res : res;
      const sy = (gy > 0 && gy < gridH - 1) ? 2 * res : res;
      const dzdx = (zR - zL) / sx;
      const dzdy = (zU - zD) / sy;

      // Y up → ground normal = (-dz/dx, 1, +dz/dy) in renderer space
      let nx = -dzdx, ny = 1.0, nz = dzdy;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      vertices[vi + 3] = nx / len;
      vertices[vi + 4] = ny / len;
      vertices[vi + 5] = nz / len;
    }
  }
  onProgress(0.9);

  // 6) Indices (two triangles / quad)
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
  };
}

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

function clampInt(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export type TerrainWorkerInput = WorkerInput;
export type TerrainWorkerOutput = WorkerOutput;
