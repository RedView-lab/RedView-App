// ============================================
// LiDAR viewer tools — viewshed (ground seen from a point)
// ============================================
//
// R2 sweep on the analysis grid: one ray from the observer's eye to every
// border cell; along a ray a cell is seen when its elevation angle is at
// least the steepest one met before it. Answers "can I see the descent /
// the couloir / the hut from here", and where a party standing here can be
// seen from. Ground model only: trees and buildings do not block the view.

import { analysisCellAt, type AnalysisGrid, type TerrainField } from './terrainField';

/** Eye height above the ground, m. */
export const OBSERVER_HEIGHT_M = 1.7;

export interface ViewshedResult {
  /** 1 per analysis cell seen from the observer. */
  visible: Uint8Array;
  grid: AnalysisGrid;
  visibleAreaM2: number;
  /** Share of the loaded ground that is seen. */
  visibleRatio: number;
  /** Farthest ground seen, m. */
  farthestM: number;
}

export function computeViewshed(field: TerrainField, projX: number, projY: number): ViewshedResult | null {
  const grid = field.getAnalysisGrid();
  const ground = field.altitudeAt(projX, projY);
  if (ground == null || analysisCellAt(grid, projX, projY) < 0) return null;

  const { width, height, cell, altitude } = grid;
  const eye = ground + OBSERVER_HEIGHT_M;
  const ox = (projX - grid.originX) / cell;
  const oy = (projY - grid.originY) / cell;
  const visible = new Uint8Array(width * height);
  let farthest = 0;

  const castTo = (tx: number, ty: number) => {
    const dx = tx - ox;
    const dy = ty - oy;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length * 2));
    let maxTan = -Infinity;
    let last = -1;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const col = Math.round(ox + dx * t);
      const row = Math.round(oy + dy * t);
      if (col < 0 || row < 0 || col >= width || row >= height) break;
      const i = row * width + col;
      if (i === last) continue;
      last = i;
      const z = altitude[i]!;
      if (!Number.isFinite(z)) continue;
      const distance = Math.max(0.5, Math.hypot(col - ox, row - oy)) * cell;
      const tan = (z - eye) / distance;
      if (tan >= maxTan) {
        if (!visible[i]) {
          visible[i] = 1;
          if (distance > farthest) farthest = distance;
        }
        maxTan = tan;
      }
    }
  };
  for (let col = 0; col < width; col++) {
    castTo(col, 0);
    castTo(col, height - 1);
  }
  for (let row = 1; row < height - 1; row++) {
    castTo(0, row);
    castTo(width - 1, row);
  }

  let seen = 0;
  let withData = 0;
  for (let i = 0; i < visible.length; i++) {
    if (!Number.isFinite(altitude[i]!)) continue;
    withData++;
    if (visible[i]) seen++;
  }
  return {
    visible,
    grid,
    visibleAreaM2: seen * cell * cell,
    visibleRatio: withData > 0 ? seen / withData : 0,
    farthestM: farthest,
  };
}
