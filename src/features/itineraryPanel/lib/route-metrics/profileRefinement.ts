/**
 * Affinage du profil d'un tracé BRouter par le MNT (altimétrie IGN, tuiles
 * Terrarium). Module à part de profile.ts : le gestionnaire de projets charge
 * profile.ts au démarrage, et l'altimétrie (réservée à l'éditeur) n'a rien à
 * faire sur son chemin critique.
 */
import type { BrouterRoute } from '../brouter';
import { haversineM } from './elevation';
import { cleanAndInterpolateElevations } from './elevationSanitizer';
import { extractRouteProfileFromPoints } from './profile';
import { sampleTerrainElevationsAtPoints } from './terrainTiles';
import type { RouteProfilePoint } from './types';

/**
 * Profil MNT (IGN en France, Terrarium ailleurs) échantillonné à chaque sommet
 * de la géométrie BRouter (un point tous les ~20 m), sans lissage des
 * altitudes — comme un GPX importé. Jamais sur les lignes de `messages` : elles
 * ne marquent que les changements de voie (jusqu'à plusieurs km d'écart) et le
 * profil interpolé entre elles devenait une suite de segments droits, plus
 * faux que les altitudes brutes de BRouter (Grenoble → Vizille, contre l'IGN
 * tous les 10 m : écart moyen 6,9 m / max 48 m, D− 4 m au lieu de 98 m).
 * Un sommet sans altitude MNT garde celle de BRouter.
 */
export async function refineRouteProfileWithIgnAltimetry(
  route: BrouterRoute,
  signal?: AbortSignal,
): Promise<RouteProfilePoint[] | null> {
  const coordinates = route.coordinates as Array<[number, number, number?]>;
  if (coordinates.length < 2) return null;

  const points = coordinates.map(([lon, lat]) => ({ lat, lon }));
  const elevations = await sampleTerrainElevationsAtPoints(points, signal);
  let coverage = 0;
  let distanceM = 0;
  // Distances géodésiques posées d'abord : le filtre de pics les lit (pente entre voisins).
  const refined = coordinates.map(([lon, lat, brouterEle], index) => {
    if (index > 0) distanceM += haversineM(points[index - 1]!, points[index]!);
    const elevation = elevations[index];
    if (elevation != null && Number.isFinite(elevation)) {
      coverage += 1;
      return { lat, lon, distanceM, elevationM: elevation };
    }
    return { lat, lon, distanceM, elevationM: Number.isFinite(brouterEle) ? (brouterEle as number) : null };
  });

  if (coverage / coordinates.length < 0.5) return null;
  return extractRouteProfileFromPoints(cleanAndInterpolateElevations(refined));
}
