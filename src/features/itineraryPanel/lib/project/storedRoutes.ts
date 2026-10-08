import { deepEqual } from './deepEqual';
import type { ProjectDocument } from './layers';

/**
 * Tracés dans la forme stockée du document (`projects.data`, `data_json` de la
 * copie IndexedDB).
 *
 * Un tracé routé garde en mémoire `originalPoints === points` (le même
 * tableau). Sérialisé tel quel, il était écrit deux fois : la moitié du JSON
 * d'un projet routé, que gzip ne retrouve pas (fenêtre de 32 Kio) — 6,2 M
 * caractères → 3,1 M, gzip 1,33 → 0,67 Mo sur un projet de 3 itinéraires
 * (30 + 150 + 550 km), envoyés puis renvoyés par Appwrite à chaque sauvegarde.
 * Le stockage écrit alors une marque à la place de la copie, et la lecture
 * rétablit le même tableau. Un lecteur plus ancien ignore la marque et voit un
 * tracé sans `originalPoints`, que chaque lecteur traite comme `points`
 * (affichage, prédiction, export, rognage).
 */
const SAME_AS_POINTS = 'originalPointsSameAsPoints';

type DocumentItinerary = ProjectDocument['itineraries'][number];
type StoredRoute = NonNullable<DocumentItinerary['gpxRoute']> & { [SAME_AS_POINTS]?: unknown };

function samePoints(points: readonly object[], originalPoints: readonly object[]): boolean {
  if (points === originalPoints) return true;
  if (points.length !== originalPoints.length) return false;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index] !== originalPoints[index] && !deepEqual(points[index], originalPoints[index])) return false;
  }
  return true;
}

/** Applique `update` aux itinéraires qu'il change ; le document lui-même si aucun ne change. */
function mapRoutes(
  document: ProjectDocument,
  update: (route: StoredRoute) => StoredRoute | null,
): ProjectDocument {
  let changed = false;
  const itineraries = document.itineraries.map((itinerary) => {
    const route = itinerary.gpxRoute as StoredRoute | undefined;
    const next = route && typeof route === 'object' ? update(route) : null;
    if (!next) return itinerary;
    changed = true;
    return { ...itinerary, gpxRoute: next };
  });
  return changed ? { ...document, itineraries } : document;
}

/** Document à sérialiser pour le stockage : `originalPoints` identique à `points` remplacé par la marque. */
export function packStoredDocument(document: ProjectDocument): ProjectDocument {
  return mapRoutes(document, (route) => {
    const { points, originalPoints } = route;
    if (!Array.isArray(points) || !Array.isArray(originalPoints) || !samePoints(points, originalPoints)) return null;
    const packed: StoredRoute = { ...route, [SAME_AS_POINTS]: true };
    delete packed.originalPoints;
    return packed;
  });
}

/**
 * Document lu dans le stockage : la marque redevient `originalPoints === points`.
 * Un `originalPoints` réellement écrit (par une version qui ignorait la marque)
 * l'emporte sur elle.
 */
export function unpackStoredDocument(document: ProjectDocument): ProjectDocument {
  return mapRoutes(document, (route) => {
    if (!(SAME_AS_POINTS in route)) return null;
    const { [SAME_AS_POINTS]: same, ...rest } = route;
    if (same === true && rest.originalPoints === undefined && Array.isArray(rest.points)) {
      rest.originalPoints = rest.points;
    }
    return rest;
  });
}
