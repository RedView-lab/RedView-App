// ============================================
// LiDAR viewer tools — draped analysis-cell meshes
// ============================================
//
// Area results (avalanche reach, viewshed) are drawn as translucent quads
// draped on the ground model, one per analysis cell, through the
// renderer's analysis mesh: depth-tested, so trees and ridges in front
// still hide them.

import type { AnalysisGrid, TerrainField } from '../terrain/terrainField';
import type { Rgba } from '../types';

export interface OverlayMeshData {
  /** x, y, z per vertex (render frame). */
  vertices: Float32Array;
  /** RGBA per vertex. */
  colors: Uint8Array;
  indices: Uint32Array;
}

/**
 * Quads of `cells` (analysis grid indices), coloured by `colorOf(k)` for
 * the k-th listed cell, lifted above the ground so they do not z-fight it.
 */
export function buildCellMesh(
  field: TerrainField,
  grid: AnalysisGrid,
  cells: ArrayLike<number>,
  colorOf: (k: number) => Rgba,
): OverlayMeshData {
  const count = cells.length;
  const vertices = new Float32Array(count * 4 * 3);
  const colors = new Uint8Array(count * 4 * 4);
  const indices = new Uint32Array(count * 6);
  const half = grid.cell / 2;
  // Corners are read on the fine ground model; a coarse quad still sags
  // between them on convex ground, hence a bias growing with the cell.
  const bias = 0.3 + 0.12 * grid.cell;
  let v = 0;
  for (let k = 0; k < count; k++) {
    const i = cells[k]!;
    const col = i % grid.width;
    const row = (i - col) / grid.width;
    const cx = grid.originX + col * grid.cell;
    const cy = grid.originY + row * grid.cell;
    const fallback = grid.altitude[i]!;
    const color = colorOf(k);
    for (const [dx, dy] of QUAD_CORNERS) {
      const x = cx + dx * half;
      const y = cy + dy * half;
      const z = field.altitudeAt(x, y) ?? fallback;
      vertices[v * 3] = x - field.centerX;
      vertices[v * 3 + 1] = z - field.centerZ + bias;
      vertices[v * 3 + 2] = -(y - field.centerY);
      colors.set(color, v * 4);
      v++;
    }
    const base = k * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], k * 6);
  }
  return { vertices, colors, indices };
}

const QUAD_CORNERS: ReadonlyArray<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** Concatenates meshes into one draw; `null` when there is nothing to draw. */
export function mergeMeshes(meshes: readonly OverlayMeshData[]): OverlayMeshData | null {
  const parts = meshes.filter((m) => m.indices.length > 0);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of parts) {
    vertexCount += m.vertices.length / 3;
    indexCount += m.indices.length;
  }
  const vertices = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 4);
  const indices = new Uint32Array(indexCount);
  let vOffset = 0;
  let iOffset = 0;
  for (const m of parts) {
    vertices.set(m.vertices, vOffset * 3);
    colors.set(m.colors, vOffset * 4);
    for (let k = 0; k < m.indices.length; k++) indices[iOffset + k] = m.indices[k]! + vOffset;
    vOffset += m.vertices.length / 3;
    iOffset += m.indices.length;
  }
  return { vertices, colors, indices };
}
