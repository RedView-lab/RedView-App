/**
 * Altitudes d'un GPX importé reprises du MNT (altimétrie IGN, tuiles
 * Terrarium). Module à part d'imported-route.ts, hors du barrel `routes` : le
 * gestionnaire de projets charge les deux au démarrage, et l'altimétrie
 * (réservée à l'import GPX de l'éditeur) n'a rien à faire sur son chemin
 * critique.
 */
import { cleanAndInterpolateElevations } from '../route-metrics/elevationSanitizer';
import { sampleTerrainElevationsAtPoints } from '../route-metrics/terrainTiles';
import type { Itinerary } from '../../types';

export async function refineImportedRoutePointsWithIgnAltimetry(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
  signal?: AbortSignal,
): Promise<NonNullable<Itinerary['gpxRoute']>['points'] | null> {
  if (points.length < 2) return null;

  const elevations = await sampleTerrainElevationsAtPoints(points, signal);
  let coverage = 0;
  const refined = points.map((point, index) => {
    const elevation = elevations[index];
    if (elevation != null && Number.isFinite(elevation)) {
      coverage += 1;
      return {
        ...point,
        elevationM: elevation,
      };
    }
    return point;
  });

  return coverage / points.length >= 0.6 ? cleanAndInterpolateElevations(refined) : null;
}
