// ============================================
// LiDAR viewer tools — polygon draped on the ground model
// ============================================
//
// The area tool's fill follows the relief: the polygon is cut by a grid
// (each cell clipped exactly, Sutherland–Hodgman) and every piece is lifted
// onto the ground, so the fill hugs ridges and gullies instead of floating
// as a flat sheet between its vertices.

import type { TerrainField } from '../terrain/terrainField';
import type { Rgba } from '../types';
import type { OverlayMeshData } from './cellMesh';

/** Grid cells covering the polygon's bounding box at most. */
const MAX_CELLS = 30_000;
/** Lift above the ground (z-fighting), m. */
const LIFT_M = 0.25;

type Point2 = [number, number];

/** Clips `polygon` to the axis-aligned box (Sutherland–Hodgman, box = convex clip). */
function clipToBox(polygon: Point2[], minX: number, minY: number, maxX: number, maxY: number): Point2[] {
  let out = polygon;
  const edges: Array<[(p: Point2) => boolean, (a: Point2, b: Point2) => Point2]> = [
    [(p) => p[0] >= minX, (a, b) => lerpAt(a, b, (minX - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= maxX, (a, b) => lerpAt(a, b, (maxX - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= minY, (a, b) => lerpAt(a, b, (minY - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= maxY, (a, b) => lerpAt(a, b, (maxY - a[1]) / (b[1] - a[1]))],
  ];
  for (const [inside, cut] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k]!;
      const prev = input[(k + input.length - 1) % input.length]!;
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(cut(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(cut(prev, cur));
      }
    }
  }
  return out;
}

function lerpAt(a: Point2, b: Point2, t: number): Point2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function buildDrapedPolygonMesh(
  field: TerrainField,
  vertices: ReadonlyArray<{ projX: number; projY: number }>,
  color: Rgba,
): OverlayMeshData | null {
  if (vertices.length < 3) return null;
  const polygon: Point2[] = vertices.map((v) => [v.projX, v.projY]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const step = Math.max(field.cell, Math.sqrt(((maxX - minX) * (maxY - minY)) / MAX_CELLS));
  const positions: number[] = [];
  const indices: number[] = [];
  const pushVertex = (x: number, y: number): number => {
    const z = field.altitudeAt(x, y);
    positions.push(x - field.centerX, (z ?? field.centerZ) - field.centerZ + LIFT_M, -(y - field.centerY));
    return positions.length / 3 - 1;
  };
  for (let y0 = minY; y0 < maxY; y0 += step) {
    for (let x0 = minX; x0 < maxX; x0 += step) {
      const piece = clipToBox(polygon, x0, y0, x0 + step, y0 + step);
      if (piece.length < 3) continue;
      if (piece.some(([x, y]) => field.altitudeAt(x, y) == null)) continue;
      // Fan from the centroid: pieces are convex except where a concave
      // polygon corner falls inside one cell.
      let cx = 0;
      let cy = 0;
      for (const [x, y] of piece) { cx += x / piece.length; cy += y / piece.length; }
      const centre = pushVertex(cx, cy);
      const first = positions.length / 3;
      for (const [x, y] of piece) pushVertex(x, y);
      for (let k = 0; k < piece.length; k++) {
        indices.push(centre, first + k, first + ((k + 1) % piece.length));
      }
    }
  }
  if (indices.length === 0) return null;
  const vertexCount = positions.length / 3;
  const colors = new Uint8Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) colors.set(color, v * 4);
  return { vertices: Float32Array.from(positions), colors, indices: Uint32Array.from(indices) };
}
