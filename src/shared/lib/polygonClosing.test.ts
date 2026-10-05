import { describe, expect, it } from 'vitest';

import { closePolygonAt, polygonCloseIndex, polygonVertexHit } from './polygonClosing';

const SQUARE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('polygonVertexHit', () => {
  it('trouve le sommet sous le clic, dans la tolérance', () => {
    expect(polygonVertexHit(SQUARE, { x: 103, y: 98 })).toBe(2);
    expect(polygonVertexHit(SQUARE, { x: 50, y: 50 })).toBe(-1);
    expect(polygonVertexHit(SQUARE, { x: 112, y: 100 })).toBe(-1);
  });

  it('prend le plus proche, le premier posé à égalité', () => {
    const close = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 0 }];
    expect(polygonVertexHit(close, { x: 4, y: 0 })).toBe(1);
    expect(polygonVertexHit(close, { x: 0, y: 0 })).toBe(0);
  });

  it('ignore les sommets hors écran', () => {
    expect(polygonVertexHit([null, { x: 10, y: 10 }], { x: 10, y: 10 })).toBe(1);
  });
});

describe('closePolygonAt', () => {
  it('premier ou dernier sommet : tout le tracé', () => {
    expect(closePolygonAt(['a', 'b', 'c', 'd'], 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(closePolygonAt(['a', 'b', 'c', 'd'], 3)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sommet du milieu : la boucle part de lui, la queue est abandonnée', () => {
    expect(closePolygonAt(['a', 'b', 'c', 'd', 'e'], 1)).toEqual(['b', 'c', 'd', 'e']);
    expect(closePolygonAt(['a', 'b', 'c', 'd', 'e'], 2)).toEqual(['c', 'd', 'e']);
  });
});

describe('polygonCloseIndex', () => {
  it('ferme dès que la boucle a assez de sommets', () => {
    expect(polygonCloseIndex(SQUARE, { x: 1, y: 1 })).toBe(0);
    expect(polygonCloseIndex(SQUARE, { x: 99, y: 1 })).toBe(1);
  });

  it('refuse une boucle trop petite', () => {
    // Fermer sur l'avant-dernier sommet ne laisserait que 2 sommets.
    expect(polygonCloseIndex(SQUARE, { x: 100, y: 100 })).toBe(-1);
    // Deux sommets posés : rien à fermer.
    expect(polygonCloseIndex(SQUARE.slice(0, 2), { x: 0, y: 0 })).toBe(-1);
  });
});
