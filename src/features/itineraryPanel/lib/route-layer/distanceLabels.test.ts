import { describe, expect, it } from 'vitest';
import {
  buildRouteDistanceLabels,
  placeLabelBoxes,
  resolveDistanceLabelStepKm,
  type ScreenLabelBox,
} from './distanceLabels';

/** Trace plein est le long de l'équateur, un point par km, `distanceM` renseigné. */
function straightRoute(totalKm: number, withDistance = true) {
  const kmPerDegree = 111.195;
  return Array.from({ length: totalKm + 1 }, (_, km) => ({
    lat: 0,
    lon: km / kmPerDegree,
    ...(withDistance ? { distanceM: km * 1000 } : {}),
  }));
}

describe('resolveDistanceLabelStepKm', () => {
  it('borne tous les 25 km jusqu’à 300 km, tous les 50 km au-delà', () => {
    expect(resolveDistanceLabelStepKm(120)).toBe(25);
    expect(resolveDistanceLabelStepKm(300)).toBe(25);
    expect(resolveDistanceLabelStepKm(301)).toBe(50);
    expect(resolveDistanceLabelStepKm(2500)).toBe(50);
  });
});

describe('buildRouteDistanceLabels', () => {
  it('pose une borne par pas sur une trace courte', () => {
    const labels = buildRouteDistanceLabels(straightRoute(110));
    expect(labels.map((label) => label.km)).toEqual([25, 50, 75, 100]);
    expect(labels.map((label) => label.rank)).toEqual([2, 1, 2, 0]);
  });

  it('passe à 50 km sur une longue trace', () => {
    const labels = buildRouteDistanceLabels(straightRoute(420));
    expect(labels.map((label) => label.km)).toEqual([50, 100, 150, 200, 250, 300, 350, 400]);
    expect(labels.find((label) => label.km === 200)?.rank).toBe(0);
  });

  it('ne pose pas de borne sur le drapeau d’arrivée', () => {
    expect(buildRouteDistanceLabels(straightRoute(105)).map((label) => label.km)).toEqual([25, 50, 75]);
    expect(buildRouteDistanceLabels(straightRoute(20))).toEqual([]);
  });

  it('interpole la position au km exact, même sans distanceM', () => {
    const route = straightRoute(60, false).filter((_, index) => index % 7 === 0);
    const [first] = buildRouteDistanceLabels(route);
    expect(first?.km).toBe(25);
    expect(first!.lngLat[0] * 111.195).toBeCloseTo(25, 1);
    expect(first!.lngLat[1]).toBe(0);
  });

  it('suit les distanceM de la trace comme le graphe', () => {
    const route = straightRoute(100).map((point) => ({ ...point, distanceM: point.distanceM! * 2 }));
    expect(buildRouteDistanceLabels(route).map((label) => label.km)).toEqual(
      [25, 50, 75, 100, 125, 150, 175],
    );
  });
});

describe('placeLabelBoxes', () => {
  const box = (x: number, km: number, rank: number): ScreenLabelBox => ({ x, y: 0, width: 40, height: 18, km, rank });

  it('centre les pastilles sur la trace quand la place est libre', () => {
    const placed = placeLabelBoxes([box(0, 25, 2), box(80, 50, 1)], 6);
    expect(placed.get(0)).toEqual([0, 0]);
    expect(placed.get(1)).toEqual([0, 0]);
  });

  it('décale la borne la moins importante quand deux pastilles se touchent', () => {
    const placed = placeLabelBoxes([box(0, 25, 2), box(30, 50, 1)], 6);
    expect(placed.get(1)).toEqual([0, 0]);
    expect(placed.get(0)).toEqual([0, -24]);
  });

  it('masque une borne qui n’a aucune position libre', () => {
    const crowd = [box(0, 50, 0), box(0, 100, 0), box(0, 150, 0), box(0, 200, 0), box(0, 250, 0), box(0, 25, 2)];
    const placed = placeLabelBoxes(crowd, 6);
    expect(placed.size).toBe(5);
    expect(placed.has(5)).toBe(false);
  });

  it('laisse la place aux marqueurs de la trace', () => {
    const obstacle = { x: 205, y: 4, width: 26, height: 25 };
    const placed = placeLabelBoxes([box(0, 25, 2), box(200, 50, 0)], 6, [obstacle]);
    expect(placed.get(0)).toEqual([0, 0]);
    expect(placed.get(1)).not.toEqual([0, 0]);
  });

  it('ignore une borne non projetable', () => {
    expect(placeLabelBoxes([box(Number.NaN, 25, 0)], 6).size).toBe(0);
  });
});
