// ============================================
// Outils du viewer LiDAR — champ de vision (sol vu depuis un point)
// ============================================
//
// Balayage R2 sur la grille d'analyse : un rayon de l'œil de l'observateur vers
// chaque cellule du bord ; le long d'un rayon, une cellule est vue quand son
// angle d'élévation est au moins le plus raide rencontré avant elle. Répond à
// « vois-je la descente / le couloir / le refuge d'ici », et d'où un groupe
// placé ici peut être vu. Modèle de sol seulement : arbres et bâtiments ne
// bloquent pas la vue.

import { analysisCellAt, type AnalysisGrid, type TerrainField } from './terrainField';

/** Hauteur de l'œil au-dessus du sol, m. */
export const OBSERVER_HEIGHT_M = 1.7;

export interface ViewshedResult {
  /** 1 par cellule d'analyse vue depuis l'observateur. */
  visible: Uint8Array;
  grid: AnalysisGrid;
  visibleAreaM2: number;
  /** Part du sol chargé qui est vue. */
  visibleRatio: number;
  /** Sol vu le plus lointain, m. */
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
