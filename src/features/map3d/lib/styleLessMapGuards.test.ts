import mapboxgl from 'mapbox-gl';
import { describe, expect, it } from 'vitest';

import { installStyleLessMapGuards } from './styleLessMapGuards';

type MapLike = { style?: unknown; getSource(id: string): unknown; getLayer(id: string): unknown };

/** Carte sans constructeur (pas de WebGL ici) : seul l'état `style` compte pour ces méthodes. */
function mapWith(style: unknown): MapLike {
  const map = Object.create(mapboxgl.Map.prototype) as MapLike;
  map.style = style;
  return map;
}

describe('styleLessMapGuards', () => {
  it('sans style chargé, getSource/getLayer répondent « introuvable » au lieu de lever', () => {
    const bare = mapWith(undefined);
    expect(() => bare.getSource('route')).toThrow(); // comportement de Mapbox GL sans le correctif
    installStyleLessMapGuards();
    expect(bare.getSource('route')).toBeUndefined();
    expect(bare.getLayer('route-line')).toBeUndefined();
  });

  it('avec un style, les appels passent à Mapbox inchangés', () => {
    installStyleLessMapGuards();
    const map = mapWith({
      getOwnSource: (id: string) => ({ id, type: 'geojson' }),
      // Mapbox renvoie la forme sérialisée du calque trouvé.
      getOwnLayer: (id: string) => ({ type: 'line', serialize: () => ({ id, type: 'line' }) }),
    });
    expect(map.getSource('route')).toEqual({ id: 'route', type: 'geojson' });
    expect(map.getLayer('route-line')).toEqual({ id: 'route-line', type: 'line' });
  });
});
