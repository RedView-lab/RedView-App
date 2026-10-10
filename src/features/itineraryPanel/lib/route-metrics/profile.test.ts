import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrouterRoute } from '../brouter';

const { sampleTerrainElevationsAtPoints } = vi.hoisted(() => ({ sampleTerrainElevationsAtPoints: vi.fn() }));
vi.mock('./terrainTiles', () => ({ sampleTerrainElevationsAtPoints }));

import { refineRouteProfileWithIgnAltimetry } from './profile';

/** Route de 2 km vers le nord, un sommet tous les ~111 m, un seul message à l'arrivée. */
function buildRoute(): BrouterRoute {
  const coordinates: Array<[number, number, number]> = [];
  for (let i = 0; i <= 18; i += 1) coordinates.push([6, 45 + i * 0.001, 500]);
  const last = coordinates[coordinates.length - 1]!;
  return {
    coordinates: coordinates as unknown as [number, number][],
    distanceM: 2_000,
    durationS: 0,
    ascentM: 0,
    descentM: 0,
    raw: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          messages: [
            ['Longitude', 'Latitude', 'Elevation', 'Distance', 'WayTags'],
            [String(last[0] * 1e6), String(last[1] * 1e6), '500', '2000', 'highway=tertiary'],
          ],
        },
      }],
    },
  };
}

describe('refineRouteProfileWithIgnAltimetry', () => {
  beforeEach(() => {
    sampleTerrainElevationsAtPoints.mockReset();
  });

  it('échantillonne le MNT à chaque sommet de la géométrie, sans lisser une bosse', async () => {
    const route = buildRoute();
    // Bosse de 30 m au milieu : un profil pris aux seules lignes de messages l'effaçait.
    sampleTerrainElevationsAtPoints.mockImplementation(async (points: unknown[]) =>
      points.map((_, i) => (i === 9 ? 530 : 500 + i)));

    const profile = await refineRouteProfileWithIgnAltimetry(route);

    expect(sampleTerrainElevationsAtPoints).toHaveBeenCalledTimes(1);
    expect(sampleTerrainElevationsAtPoints.mock.calls[0]![0]).toHaveLength(route.coordinates.length);
    expect(profile).toHaveLength(route.coordinates.length);
    expect(profile![9]!.elevationM).toBe(530);
    expect(profile![3]!.elevationM).toBe(503);
    expect(profile![18]!.distanceM).toBeGreaterThan(1_990);
    expect(profile![18]!.distanceM).toBeLessThan(2_010);
  });

  it("garde l'altitude BRouter d'un sommet sans MNT", async () => {
    const route = buildRoute();
    sampleTerrainElevationsAtPoints.mockImplementation(async (points: unknown[]) =>
      points.map((_, i) => (i === 4 ? null : 510)));

    const profile = await refineRouteProfileWithIgnAltimetry(route);

    expect(profile![4]!.elevationM).toBe(500);
    expect(profile![5]!.elevationM).toBe(510);
  });

  it('renonce sous 50 % de couverture MNT', async () => {
    sampleTerrainElevationsAtPoints.mockImplementation(async (points: unknown[]) =>
      points.map((_, i) => (i < 5 ? 600 : null)));

    expect(await refineRouteProfileWithIgnAltimetry(buildRoute())).toBeNull();
  });
});
