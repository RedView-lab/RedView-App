import { closePolygonAt } from '@/shared/lib/polygonClosing';

import type { LngLatPair } from './zoneGeometry';

/**
 * Zone polygonale en cours de tracé sur la carte (sous-outil « zone ») :
 * sommets posés au clic, curseur au sol, et sommet sur lequel un clic
 * fermerait la zone (`shared/lib/polygonClosing`), -1 sinon.
 */
export interface CommentZoneDrawing {
  vertices: readonly LngLatPair[];
  cursor: LngLatPair | null;
  closeIndex: number;
}

/**
 * Formes à dessiner pour un tracé en cours (même source que les zones, voir
 * `useCommentZoneLayer`) : la zone prévisualisée (sommets + curseur, ou la
 * boucle qu'un clic fermerait) en pointillés, la ligne des deux premiers
 * points, la « queue » laissée hors d'une boucle fermée sur un sommet du
 * milieu, et les sommets (`vertex`, `close` = sommet de fermeture survolé).
 */
export function zoneDrawingFeatures(drawing: CommentZoneDrawing): GeoJSON.Feature[] {
  const { vertices, cursor, closeIndex } = drawing;
  const features: GeoJSON.Feature[] = [];
  const closing = closeIndex >= 0 && closeIndex < vertices.length;
  const outline = closing ? closePolygonAt(vertices, closeIndex) : cursor ? [...vertices, cursor] : [...vertices];

  if (outline.length >= 3) {
    features.push({
      type: 'Feature',
      properties: { draft: 1 },
      geometry: { type: 'Polygon', coordinates: [[...outline, outline[0]].map(copy)] },
    });
  } else if (outline.length === 2) {
    features.push({ type: 'Feature', properties: { draft: 1 }, geometry: { type: 'LineString', coordinates: outline.map(copy) } });
  }
  if (closing && closeIndex > 0 && closeIndex < vertices.length - 1) {
    features.push({
      type: 'Feature',
      properties: { draft: 1 },
      geometry: { type: 'LineString', coordinates: vertices.slice(0, closeIndex + 1).map(copy) },
    });
  }
  vertices.forEach((vertex, index) => {
    features.push({
      type: 'Feature',
      properties: { draft: 1, vertex: 1, close: index === closeIndex ? 1 : 0 },
      geometry: { type: 'Point', coordinates: copy(vertex) },
    });
  });
  return features;
}

function copy([lng, lat]: LngLatPair): [number, number] {
  return [lng, lat];
}
