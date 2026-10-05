/**
 * Fermeture d'un polygone tracé point par point (zone de commentaire sur la
 * carte, surface et zone de commentaire du viewer LiDAR) : un clic sur un
 * sommet déjà posé ferme la zone sur ce sommet.
 *  - premier sommet (ou dernier : double clic) : tout le tracé ;
 *  - sommet du milieu : la boucle part de ce sommet (lasso) — les sommets
 *    posés avant lui, une « queue » hors de la boucle, sont abandonnés.
 */

export interface ScreenXY {
  x: number;
  y: number;
}

/** Rayon de prise d'un sommet à l'écran (px CSS). */
export const POLYGON_CLOSE_HIT_PX = 10;

/**
 * Sommet sous le clic : le plus proche dans `tolerancePx` (à égalité, le
 * premier posé), -1 s'il n'y en a pas. `null` : sommet hors de l'écran.
 */
export function polygonVertexHit(
  vertices: readonly (ScreenXY | null)[],
  click: ScreenXY,
  tolerancePx = POLYGON_CLOSE_HIT_PX,
): number {
  let best = -1;
  let bestDistance = tolerancePx;
  vertices.forEach((vertex, index) => {
    if (!vertex) return;
    const distance = Math.hypot(vertex.x - click.x, vertex.y - click.y);
    if (distance < bestDistance || (distance === bestDistance && best === -1)) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Sommets de la zone fermée sur le sommet `index` (voir l'en-tête). */
export function closePolygonAt<T>(vertices: readonly T[], index: number): T[] {
  if (index <= 0 || index >= vertices.length - 1) return [...vertices];
  return vertices.slice(index);
}

/**
 * Sommet sur lequel un clic fermerait la zone, ou -1 (aucun sommet touché,
 * ou la zone fermée aurait moins de `minVertices` sommets).
 */
export function polygonCloseIndex(
  vertices: readonly (ScreenXY | null)[],
  click: ScreenXY,
  minVertices = 3,
  tolerancePx = POLYGON_CLOSE_HIT_PX,
): number {
  const index = polygonVertexHit(vertices, click, tolerancePx);
  if (index < 0) return -1;
  return closePolygonAt(vertices, index).length >= minVertices ? index : -1;
}
