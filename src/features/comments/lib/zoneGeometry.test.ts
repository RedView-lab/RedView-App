import { describe, expect, it } from 'vitest';

import { clusterPins, clusterSignature } from './clusters';
import { closedRing, isZoneDrag, zoneFromPolygon, zoneFromScreenRect } from './zoneGeometry';

describe('zones et regroupements', () => {
  it('rectangle écran → empreinte au sol densifiée ; un petit geste reste un clic', () => {
    const unproject = ({ x, y }: { x: number; y: number }) => [x / 1000, y / 1000] as [number, number];
    expect(isZoneDrag({ x: 0, y: 0 }, { x: 5, y: 40 })).toBe(false);
    const zone = zoneFromScreenRect({ x: 100, y: 100 }, { x: 300, y: 200 }, unproject)!;
    expect(zone.ring).toHaveLength(32);
    expect(zone.ring[0]).toEqual([0.1, 0.1]);
    expect(closedRing(zone).at(-1)).toEqual([0.1, 0.1]);
  });

  it('points au-dessus de l’horizon ramenés au sol, ceux hors du sol écartés', () => {
    const zone = zoneFromScreenRect({ x: 0, y: 0 }, { x: 100, y: 100 }, ({ x, y }) => (y < 50 ? null : [x, y]), 50)!;
    expect(zone.ring.every(([, lat]) => lat >= 50)).toBe(true);
    expect(zoneFromScreenRect({ x: 0, y: 0 }, { x: 100, y: 100 }, () => null)).toBeNull();
  });

  it('polygone simplifié à 64 sommets au plus', () => {
    const points = Array.from({ length: 200 }, (_, i) => [Math.cos(i / 32), Math.sin(i / 32)] as [number, number]);
    expect(zoneFromPolygon(points)!.ring).toHaveLength(64);
    expect(zoneFromPolygon([[0, 0], [1, 1]])).toBeNull();
  });

  it('bulles proches regroupées, dans l’ordre des fils', () => {
    const clusters = clusterPins([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 10 },
      { id: 'c', x: 200, y: 0 },
      { id: 'd', x: Number.NaN, y: 0 },
    ]);
    expect(clusters.map((cluster) => cluster.ids)).toEqual([['a', 'b'], ['c']]);
    expect(clusterSignature(clusters)).toBe('a,b');
  });
});
