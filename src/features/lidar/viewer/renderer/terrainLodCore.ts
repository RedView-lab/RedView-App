// ============================================
// Terrain mesh LOD: chunked geomipmapping over the tiles' DTM grids
// ============================================
//
// The DTM mesh (≈1 m grid, 2.1 M triangles per tile) only fills the gaps
// between the points, yet drawn whole it cost more than the points: 19 M
// triangles for 9 tiles held the point budget of an integrated GPU at
// 1.5 M points instead of 6 M. Each tile grid is cut into chunks of
// CHUNK_QUADS quads; every frame a visible chunk takes the coarsest stride
// (1…32 grid steps) whose height error projects under ERROR_PX and whose
// quads stay under MAX_QUAD_PX, neighbouring chunks (across tiles too)
// differ by one level at most, and an edge facing a coarser neighbour snaps
// its in-between vertices onto the coarse edge: no T-junction cracks.
// A coarse chunk is pushed back along the view rays by its height error
// (`pushBack`, read by the terrain vertex shader), so it never hides a point
// lying on the true surface; a move along the view ray keeps every vertex
// on the same pixel, so chunks pushed by different amounts still join on
// screen. Vertices stay the full-resolution buffers (each kept vertex keeps
// its own normal and colour); a chunk is one indexed draw of an index
// pattern shared by every chunk of that shape, relative to its first vertex.
//
// This module is the GPU-API-free part (chunks, levels, patterns), shared by
// the WebGPU (`terrainLod.ts`) and WebGL 2 (`webgl/glTerrainLod.ts`) drawers.

import { extractFrustumPlanes, frustumTestAABB, OUTSIDE } from '../lod/frustum';

/** Vertex grid of one tile inside the merged terrain buffers (rows of `gridWidth` vertices). */
export interface TerrainPart {
  vertexOffset: number;
  gridWidth: number;
  gridHeight: number;
}

export interface TerrainMeshData {
  /** x, y, z, nx, ny, nz per vertex (render frame). */
  vertices: Float32Array;
  /** RGBA8 per vertex. */
  colors: Uint8Array;
  parts: TerrainPart[];
}

const CHUNK_QUADS = 128;
/** Strides 1, 2, 4 … 32 grid steps. */
const LEVELS = 6;
/**
 * Largest height error of a coarser level, projected (device px). The mesh
 * sits behind the points (pushed back by that error), so it only shapes the
 * holes and silhouettes the points leave open.
 */
const ERROR_PX = 6;
/** Largest quad of a coarser level, projected (device px): shading and silhouettes stay smooth. */
const MAX_QUAD_PX = 32;
/** Extra push-back (m) of every chunk drawn below full resolution. */
const PUSH_BACK_MARGIN = 0.05;
export const TERRAIN_VERTEX_FLOATS = 6;

/** Sides of a chunk, as bits of the stitching mask. */
const ROW_MIN = 1;
const COL_MAX = 2;
const ROW_MAX = 4;
const COL_MIN = 8;
const SIDES = [ROW_MIN, COL_MAX, ROW_MAX, COL_MIN] as const;

export interface TerrainChunk {
  quadsW: number;
  quadsH: number;
  gridWidth: number;
  /** First vertex of the chunk in the merged buffers; pattern indices are relative to it. */
  baseVertex: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** World size of one grid step. */
  cell: number;
  /** Largest height error of each level (metres), non-decreasing; Infinity above `maxLevel`. */
  errors: Float32Array;
  /** Coarsest level the chunk's size allows. */
  maxLevel: number;
  /** Neighbour chunk per side (ROW_MIN, COL_MAX, ROW_MAX, COL_MIN order), −1 at the scene edge. */
  neighbours: [number, number, number, number];
  /** World (x, z) direction of growing grid columns and rows. */
  colAxis: [number, number];
  rowAxis: [number, number];
}

/** Index list of one chunk shape, keyed by `patternKey`. */
export interface TerrainIndexPattern {
  key: string;
  indices: Uint32Array<ArrayBuffer>;
}

/** Grid positions of a level along one chunk axis: multiples of the stride, then the end. */
function levelPositions(quads: number, stride: number): number[] {
  const out: number[] = [];
  for (let p = 0; p < quads; p += stride) out.push(p);
  out.push(quads);
  return out;
}

/** Largest position of `coarse` (sorted, starting at 0) not above `p`. */
function snapDown(p: number, coarse: number[]): number {
  let best = 0;
  for (const c of coarse) {
    if (c > p) break;
    best = c;
  }
  return best;
}

/**
 * Index list of a chunk of `quadsW`×`quadsH` quads at `stride`, relative to
 * its first vertex in a grid of `gridWidth` vertices per row. Edges in
 * `stitch` face a neighbour one level coarser: their vertices snap down to
 * that level's positions (degenerate triangles dropped). Same winding as the
 * heightmap mesh (tl, tr, bl / tr, br, bl).
 */
export function buildChunkIndices(
  gridWidth: number,
  quadsW: number,
  quadsH: number,
  stride: number,
  stitch: number,
): Uint32Array<ArrayBuffer> {
  const cols = levelPositions(quadsW, stride);
  const rows = levelPositions(quadsH, stride);
  const coarseCols = levelPositions(quadsW, stride * 2);
  const coarseRows = levelPositions(quadsH, stride * 2);
  const index = (r: number, c: number): number => {
    let rr = r;
    let cc = c;
    if (r === 0 && (stitch & ROW_MIN)) cc = snapDown(c, coarseCols);
    else if (r === quadsH && (stitch & ROW_MAX)) cc = snapDown(c, coarseCols);
    if (c === 0 && (stitch & COL_MIN)) rr = snapDown(r, coarseRows);
    else if (c === quadsW && (stitch & COL_MAX)) rr = snapDown(r, coarseRows);
    return rr * gridWidth + cc;
  };
  const out: number[] = [];
  const triangle = (a: number, b: number, c: number) => {
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  };
  for (let ri = 0; ri < rows.length - 1; ri++) {
    for (let ci = 0; ci < cols.length - 1; ci++) {
      const tl = index(rows[ri]!, cols[ci]!);
      const tr = index(rows[ri]!, cols[ci + 1]!);
      const bl = index(rows[ri + 1]!, cols[ci]!);
      const br = index(rows[ri + 1]!, cols[ci + 1]!);
      triangle(tl, tr, bl);
      triangle(tr, br, bl);
    }
  }
  return new Uint32Array(out);
}

/** Largest height error of each level over the chunk: bilinear coarse surface against the full grid. */
function chunkErrors(
  vertices: Float32Array,
  base: number,
  gridWidth: number,
  quadsW: number,
  quadsH: number,
  maxLevel: number,
): Float32Array {
  const errors = new Float32Array(LEVELS);
  for (let level = 1; level <= maxLevel; level++) {
    const stride = 1 << level;
    const cols = levelPositions(quadsW, stride);
    const rows = levelPositions(quadsH, stride);
    let worst = errors[level - 1]!;
    for (let ri = 0; ri < rows.length - 1; ri++) {
      const r0 = rows[ri]!, r1 = rows[ri + 1]!;
      for (let ci = 0; ci < cols.length - 1; ci++) {
        const c0 = cols[ci]!, c1 = cols[ci + 1]!;
        const at = (r: number, c: number) => (base + r * gridWidth + c) * TERRAIN_VERTEX_FLOATS + 1;
        const h00 = vertices[at(r0, c0)]!, h01 = vertices[at(r0, c1)]!;
        const h10 = vertices[at(r1, c0)]!, h11 = vertices[at(r1, c1)]!;
        for (let r = r0; r <= r1; r++) {
          const v = (r - r0) / (r1 - r0);
          const left = h00 + (h10 - h00) * v;
          const right = h01 + (h11 - h01) * v;
          let k = at(r, c0);
          for (let c = c0; c <= c1; c++, k += TERRAIN_VERTEX_FLOATS) {
            const error = Math.abs(vertices[k]! - (left + (right - left) * ((c - c0) / (c1 - c0))));
            if (error > worst) worst = error;
          }
        }
      }
    }
    errors[level] = worst;
  }
  for (let level = maxLevel + 1; level < LEVELS; level++) errors[level] = Infinity;
  return errors;
}

/** Chunks of the terrain grids and the level each one is drawn at for the current camera. */
export class TerrainLodSelector {
  readonly chunks: TerrainChunk[] = [];
  /** Level per chunk (stride 2^level), set by `select`. */
  readonly levels: Int32Array;
  /** 1 where the chunk intersects the frustum, set by `select`. */
  readonly visible: Uint8Array;
  /** Push-back (m) per chunk along the view rays, set by `select`. */
  readonly pushBack: Float32Array<ArrayBuffer>;

  constructor(mesh: TerrainMeshData) {
    mesh.parts.forEach((part) => this.addPart(mesh.vertices, part));
    this.linkNeighbours();
    this.levels = new Int32Array(this.chunks.length);
    this.visible = new Uint8Array(this.chunks.length);
    this.pushBack = new Float32Array(Math.max(1, this.chunks.length));
  }

  private addPart(vertices: Float32Array, part: TerrainPart): void {
    const { vertexOffset, gridWidth, gridHeight } = part;
    if (gridWidth < 2 || gridHeight < 2 || (vertexOffset + gridWidth * gridHeight) * TERRAIN_VERTEX_FLOATS > vertices.length) {
      console.warn('[LiDAR terrain] Skipped a terrain part whose grid does not match its vertices.');
      return;
    }
    for (let row0 = 0; row0 < gridHeight - 1; row0 += CHUNK_QUADS) {
      for (let col0 = 0; col0 < gridWidth - 1; col0 += CHUNK_QUADS) {
        const quadsW = Math.min(CHUNK_QUADS, gridWidth - 1 - col0);
        const quadsH = Math.min(CHUNK_QUADS, gridHeight - 1 - row0);
        const baseVertex = vertexOffset + row0 * gridWidth + col0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let r = 0; r <= quadsH; r++) {
          for (let c = 0; c <= quadsW; c++) {
            const at = (baseVertex + r * gridWidth + c) * TERRAIN_VERTEX_FLOATS;
            const x = vertices[at]!, y = vertices[at + 1]!, z = vertices[at + 2]!;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
        // Strides up to the chunk's smaller side (partial chunks at a grid edge).
        const maxLevel = Math.max(0, Math.min(LEVELS - 1, Math.floor(Math.log2(Math.min(quadsW, quadsH)))));
        const corner = (r: number, c: number): [number, number] => {
          const at = (baseVertex + r * gridWidth + c) * TERRAIN_VERTEX_FLOATS;
          return [vertices[at]!, vertices[at + 2]!];
        };
        const [x0, z0] = corner(0, 0);
        const [xc, zc] = corner(0, quadsW);
        const [xr, zr] = corner(quadsH, 0);
        this.chunks.push({
          quadsW,
          quadsH,
          gridWidth,
          baseVertex,
          minX, minY, minZ, maxX, maxY, maxZ,
          cell: Math.max((maxX - minX) / quadsW, (maxZ - minZ) / quadsH),
          errors: chunkErrors(vertices, baseVertex, gridWidth, quadsW, quadsH, maxLevel),
          maxLevel,
          neighbours: [-1, -1, -1, -1],
          colAxis: [Math.sign(xc - x0), Math.sign(zc - z0)],
          rowAxis: [Math.sign(xr - x0), Math.sign(zr - z0)],
        });
      }
    }
  }

  /**
   * Neighbours by shared edges: overlapping along the edge and touching
   * across it (within half a grid step), so tiles join as well.
   */
  private linkNeighbours(): void {
    const chunks = this.chunks;
    for (let i = 0; i < chunks.length; i++) {
      const a = chunks[i]!;
      const tolerance = a.cell * 0.5;
      for (let j = 0; j < chunks.length; j++) {
        if (i === j) continue;
        const b = chunks[j]!;
        const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        const halfX = 0.5 * Math.min(a.maxX - a.minX, b.maxX - b.minX);
        const halfZ = 0.5 * Math.min(a.maxZ - a.minZ, b.maxZ - b.minZ);
        let side = -1;
        if (overlapZ > halfZ && Math.abs(b.minX - a.maxX) <= tolerance) side = this.sideOf(a, 1, 0);
        else if (overlapZ > halfZ && Math.abs(b.maxX - a.minX) <= tolerance) side = this.sideOf(a, -1, 0);
        else if (overlapX > halfX && Math.abs(b.minZ - a.maxZ) <= tolerance) side = this.sideOf(a, 0, 1);
        else if (overlapX > halfX && Math.abs(b.maxZ - a.minZ) <= tolerance) side = this.sideOf(a, 0, -1);
        if (side >= 0 && a.neighbours[side] === -1) a.neighbours[side] = j;
      }
    }
  }

  /** Index of the chunk side (ROW_MIN, COL_MAX, ROW_MAX, COL_MIN order) facing world direction (dx, dz). */
  private sideOf(chunk: TerrainChunk, dx: number, dz: number): number {
    const alongCols = dx * chunk.colAxis[0] + dz * chunk.colAxis[1];
    const alongRows = dx * chunk.rowAxis[0] + dz * chunk.rowAxis[1];
    if (Math.abs(alongCols) >= Math.abs(alongRows)) return alongCols > 0 ? 1 : 3;
    return alongRows > 0 ? 2 : 0;
  }

  static patternKey(gridWidth: number, quadsW: number, quadsH: number, level: number, stitch: number): string {
    return `${gridWidth}:${quadsW}:${quadsH}:${level}:${stitch}`;
  }

  /**
   * Every pattern of the full-size chunks (each level, each stitched-side
   * combination; ~8 MB per grid width), one list per grid width: drawers
   * upload them once, so no buffer is created while drawing.
   */
  sharedPatterns(): TerrainIndexPattern[][] {
    const widths = new Set(this.chunks.filter((c) => c.quadsW === CHUNK_QUADS && c.quadsH === CHUNK_QUADS).map((c) => c.gridWidth));
    const groups: TerrainIndexPattern[][] = [];
    for (const gridWidth of widths) {
      const lists: TerrainIndexPattern[] = [];
      for (let level = 0; level < LEVELS; level++) {
        // The coarsest level never meets a coarser neighbour.
        const stitches = level < LEVELS - 1 ? 16 : 1;
        for (let stitch = 0; stitch < stitches; stitch++) {
          lists.push({
            key: TerrainLodSelector.patternKey(gridWidth, CHUNK_QUADS, CHUNK_QUADS, level, stitch),
            indices: buildChunkIndices(gridWidth, CHUNK_QUADS, CHUNK_QUADS, 1 << level, stitch),
          });
        }
      }
      groups.push(lists);
    }
    return groups;
  }

  /** Key of the pattern a chunk is drawn with at `level` (see `sharedPatterns`). */
  static chunkPatternKey(chunk: TerrainChunk, level: number, stitch: number): string {
    return TerrainLodSelector.patternKey(chunk.gridWidth, chunk.quadsW, chunk.quadsH, level, stitch);
  }

  /** Index list of a chunk at `level`: partial chunks (grid edges) are not in `sharedPatterns`. */
  static chunkPatternIndices(chunk: TerrainChunk, level: number, stitch: number): Uint32Array<ArrayBuffer> {
    return buildChunkIndices(chunk.gridWidth, chunk.quadsW, chunk.quadsH, 1 << level, stitch);
  }

  /** Sides of chunk `index` facing a neighbour one level coarser (stitching mask). */
  stitchOf(index: number): number {
    const chunk = this.chunks[index]!;
    const level = this.levels[index]!;
    let stitch = 0;
    for (let side = 0; side < 4; side++) {
      const n = chunk.neighbours[side]!;
      if (n >= 0 && this.levels[n]! === level + 1) stitch |= SIDES[side]!;
    }
    return stitch;
  }

  /**
   * Picks each chunk's level and visibility for this camera. `focalPx` =
   * proj[1][1] × viewport height / 2 (device px at the canvas resolution,
   * as the points).
   */
  select(viewProj: Float32Array, camX: number, camY: number, camZ: number, focalPx: number): void {
    const planes = extractFrustumPlanes(viewProj);
    const chunks = this.chunks;
    const levels = this.levels;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      this.visible[i] = frustumTestAABB(planes, chunk) === OUTSIDE ? 0 : 1;
      const dx = Math.max(chunk.minX - camX, 0, camX - chunk.maxX);
      const dy = Math.max(chunk.minY - camY, 0, camY - chunk.maxY);
      const dz = Math.max(chunk.minZ - camZ, 0, camZ - chunk.maxZ);
      const pxPerMetre = focalPx / Math.max(0.05, Math.sqrt(dx * dx + dy * dy + dz * dz));
      let level = 0;
      for (let l = chunk.maxLevel; l >= 1; l--) {
        if (chunk.errors[l]! * pxPerMetre <= ERROR_PX && (1 << l) * chunk.cell * pxPerMetre <= MAX_QUAD_PX) {
          level = l;
          break;
        }
      }
      levels[i] = level;
    }
    // Neighbours differ by one level at most (the finer one wins), so a
    // stitched edge only ever meets the next level.
    for (let pass = 0; pass < LEVELS; pass++) {
      let changed = false;
      for (let i = 0; i < chunks.length; i++) {
        for (const n of chunks[i]!.neighbours) {
          if (n >= 0 && levels[i]! > levels[n]! + 1) {
            levels[i] = levels[n]! + 1;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    for (let i = 0; i < chunks.length; i++) {
      const level = levels[i]!;
      this.pushBack[i] = level > 0 ? chunks[i]!.errors[level]! + PUSH_BACK_MARGIN : 0;
    }
  }
}
