import { describe, expect, it } from 'vitest';

import type { PoiCategory, PoiFeature } from '../../types';
import { buildCandidates, buildRouteIndex } from './enrich';
import { DEFAULT_AUTO_SORT_RULES } from './rules';

// Trace plate plein est, 2 km à 45° N ; les POI sont posés au nord (côté
// gauche dans le sens de la marche) à une distance latérale donnée.
const LAT = 45;
const M_PER_DEG_LAT = 111_320;
const route = buildRouteIndex(
  Array.from({ length: 21 }, (_, i) => ({ lat: LAT, lon: 6 + (i * 100) / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180)), elevationM: 500 })),
);

let nextId = 1;
function poiAt(category: PoiCategory, lateralM: number): PoiFeature {
  return { id: nextId++, lat: LAT + lateralM / M_PER_DEG_LAT, lon: 6.0127, category, name: null, tags: {} };
}

function candidatesFor(features: PoiFeature[]) {
  return buildCandidates(features, route, DEFAULT_AUTO_SORT_RULES, () => 200).candidates;
}

describe('tri auto : cimetières', () => {
  it("un cimetière à 80 m (centroïde de l'enclos) reste un point d'eau, de secours seulement", () => {
    const [candidate] = candidatesFor([poiAt('cemetery', 80)]);
    expect(candidate?.kind).toBe('water');
    expect(candidate?.family).toBe('water');
    expect(candidate?.fallback).toBe(true);
  });

  it('un vrai point d\'eau garde la « proximité immédiate » de 40 m', () => {
    expect(candidatesFor([poiAt('fountain', 80)])).toHaveLength(0);
    expect(candidatesFor([poiAt('drinking_water', 5)])[0]?.fallback).toBe(false);
  });

  it('un cimetière au-delà de 120 m est écarté', () => {
    expect(candidatesFor([poiAt('cemetery', 150)])).toHaveLength(0);
  });
});
