import { describe, expect, it } from 'vitest';

import type { PoiCategory } from '../types';
import { isDeclaredUndrinkable, poiWaterHint } from './waterPotability';

const poi = (category: PoiCategory, drinking?: string): { category: PoiCategory; tags: Record<string, string> } => ({
  category,
  tags: drinking ? { drinking_water: drinking } : {},
});

describe('points d\'eau déclarés non potables', () => {
  it('écartés pour toutes les sources d\'eau', () => {
    for (const category of ['drinking_water', 'water_point', 'water_tap', 'spring', 'fountain'] as const) {
      expect(isDeclaredUndrinkable(poi(category, 'no'))).toBe(true);
      expect(isDeclaredUndrinkable(poi(category, 'not'))).toBe(true);
      expect(isDeclaredUndrinkable(poi(category))).toBe(false);
      expect(isDeclaredUndrinkable(poi(category, 'yes'))).toBe(false);
    }
  });

  it('jamais un autre lieu (un cimetière reste un cimetière)', () => {
    expect(isDeclaredUndrinkable(poi('cemetery', 'no'))).toBe(false);
    expect(isDeclaredUndrinkable(poi('bakery', 'no'))).toBe(false);
  });
});

describe('note de la popup sur l\'eau', () => {
  it('fontaine, source, robinet : ce que dit OSM, sinon « non renseignée »', () => {
    expect(poiWaterHint(poi('fountain'))).toBe('Potabilité non renseignée');
    expect(poiWaterHint(poi('spring', 'yes'))).toBe('Eau potable signalée');
    expect(poiWaterHint(poi('water_tap', 'conditional'))).toBe('Potable sous conditions');
    expect(poiWaterHint(poi('spring', 'untreated'))).toBe('Eau non traitée');
  });

  it('point d\'eau potable : rien à ajouter, sauf une restriction', () => {
    expect(poiWaterHint(poi('drinking_water'))).toBeNull();
    expect(poiWaterHint(poi('drinking_water', 'conditional'))).toBe('Potable sous conditions');
  });

  it('cimetière : robinet probable, ou ce que dit OSM', () => {
    expect(poiWaterHint(poi('cemetery'))).toBe('Robinet probable, eau non garantie potable');
    expect(poiWaterHint(poi('cemetery', 'yes'))).toBe('Eau potable signalée');
    expect(poiWaterHint(poi('cemetery', 'no'))).toBe('Eau signalée non potable');
  });

  it('autres catégories : aucune note', () => {
    expect(poiWaterHint(poi('bakery'))).toBeNull();
  });
});
