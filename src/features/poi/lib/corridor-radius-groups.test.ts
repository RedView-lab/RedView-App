import { describe, expect, it } from 'vitest';

import { groupCategoriesByRadius } from './corridor-radius-groups';

describe('groupCategoriesByRadius', () => {
  it('une requête par rayon : les cimetières à 100 m ne tirent pas les commerces à 100 m', () => {
    expect(groupCategoriesByRadius(
      ['drinking_water', 'cemetery', 'bakery', 'restaurant'],
      { drinking_water: 20, cemetery: 100, bakery: 20, restaurant: 20 },
      20,
    )).toEqual([
      { radiusM: 20, categories: ['drinking_water', 'bakery', 'restaurant'] },
      { radiusM: 100, categories: ['cemetery'] },
    ]);
  });

  it('les catégories sans distance prennent le rayon de repli', () => {
    expect(groupCategoriesByRadius(['bakery', 'pass'], { bakery: 20 }, 1000)).toEqual([
      { radiusM: 20, categories: ['bakery'] },
      { radiusM: 1000, categories: ['pass'] },
    ]);
  });

  it('au-delà du plafond, fusionne les rayons voisins les plus proches au plus large', () => {
    const groups = groupCategoriesByRadius(
      ['bakery', 'cafe', 'cemetery', 'hotel'],
      { bakery: 20, cafe: 25, cemetery: 100, hotel: 500 },
      20,
      3,
    );
    expect(groups).toEqual([
      { radiusM: 25, categories: ['bakery', 'cafe'] },
      { radiusM: 100, categories: ['cemetery'] },
      { radiusM: 500, categories: ['hotel'] },
    ]);
    // Aucune catégorie perdue, aucune interrogée sous sa propre distance.
    expect(groupCategoriesByRadius(['bakery', 'cafe', 'cemetery', 'hotel'], { bakery: 20, cafe: 25, cemetery: 100, hotel: 500 }, 20, 1))
      .toEqual([{ radiusM: 500, categories: ['bakery', 'cafe', 'cemetery', 'hotel'] }]);
  });
});
