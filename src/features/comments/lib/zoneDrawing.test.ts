import { describe, expect, it } from 'vitest';

import { zoneDrawingFeatures } from './zoneDrawing';
import type { LngLatPair } from './zoneGeometry';

const A: LngLatPair = [6, 45];
const B: LngLatPair = [6.01, 45];
const C: LngLatPair = [6.01, 45.01];
const D: LngLatPair = [6, 45.01];

const geometryTypes = (features: GeoJSON.Feature[]) => features.map((feature) => feature.geometry.type);

describe('zoneDrawingFeatures', () => {
  it('un sommet et le curseur : une ligne et le sommet', () => {
    const features = zoneDrawingFeatures({ vertices: [A], cursor: B, closeIndex: -1 });
    expect(geometryTypes(features)).toEqual(['LineString', 'Point']);
  });

  it('deux sommets et le curseur : la zone prévisualisée, fermée', () => {
    const [polygon] = zoneDrawingFeatures({ vertices: [A, B], cursor: C, closeIndex: -1 });
    expect(polygon.geometry).toEqual({ type: 'Polygon', coordinates: [[A, B, C, A]] });
  });

  it('fermeture sur le premier sommet : tout le tracé, sans le curseur', () => {
    const features = zoneDrawingFeatures({ vertices: [A, B, C], cursor: [7, 46], closeIndex: 0 });
    expect(features[0].geometry).toEqual({ type: 'Polygon', coordinates: [[A, B, C, A]] });
    expect(features.filter((feature) => feature.properties?.close === 1)).toHaveLength(1);
  });

  it('fermeture sur un sommet du milieu : la boucle et la queue abandonnée', () => {
    const features = zoneDrawingFeatures({ vertices: [A, B, C, D], cursor: B, closeIndex: 1 });
    expect(features[0].geometry).toEqual({ type: 'Polygon', coordinates: [[B, C, D, B]] });
    expect(features[1].geometry).toEqual({ type: 'LineString', coordinates: [A, B] });
    expect(geometryTypes(features).filter((type) => type === 'Point')).toHaveLength(4);
  });
});
