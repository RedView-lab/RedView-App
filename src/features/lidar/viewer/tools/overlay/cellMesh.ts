// ============================================
// Outils du viewer LiDAR — maillages drapés des cellules d'analyse
// ============================================
//
// Les résultats surfaciques (portée des avalanches, champ de vision) sont
// dessinés en quads translucides drapés sur le modèle de sol, un par cellule
// d'analyse, via le maillage d'analyse du renderer : avec test de profondeur,
// les arbres et les crêtes devant les cachent donc toujours.

import type { AnalysisGrid, TerrainField } from '../terrain/terrainField';

/** Cellules régulières (centre de la cellule 0 à l'origine), avec leur altitude quand elle est connue. */
export type CellLattice = Pick<AnalysisGrid, 'width' | 'cell' | 'originX' | 'originY'> & { altitude?: ArrayLike<number> };
import type { Rgba } from '../types';

export interface OverlayMeshData {
  /** x, y, z par sommet (repère de rendu). */
  vertices: Float32Array;
  /** RGBA par sommet. */
  colors: Uint8Array;
  indices: Uint32Array;
}

/**
 * Quads de `cells` (indices de grille), colorés par `colorOf(k)` pour la k-ième
 * cellule listée, soulevés au-dessus du sol pour éviter le z-fighting.
 */
export function buildCellMesh(
  field: TerrainField,
  grid: CellLattice,
  cells: ArrayLike<number>,
  colorOf: (k: number) => Rgba,
): OverlayMeshData {
  const count = cells.length;
  const vertices = new Float32Array(count * 4 * 3);
  const colors = new Uint8Array(count * 4 * 4);
  const indices = new Uint32Array(count * 6);
  const half = grid.cell / 2;
  // Les coins sont lus sur le modèle de sol fin ; un quad grossier s'affaisse
  // encore entre eux sur un sol convexe, d'où un biais qui croît avec la cellule.
  const bias = 0.3 + 0.12 * grid.cell;
  let v = 0;
  for (let k = 0; k < count; k++) {
    const i = cells[k]!;
    const col = i % grid.width;
    const row = (i - col) / grid.width;
    const cx = grid.originX + col * grid.cell;
    const cy = grid.originY + row * grid.cell;
    const fallback = grid.altitude ? grid.altitude[i]! : field.altitudeAt(cx, cy) ?? field.minAltitudeM;
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

/** Concatène des maillages en un seul draw ; `null` quand il n'y a rien à dessiner. */
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
