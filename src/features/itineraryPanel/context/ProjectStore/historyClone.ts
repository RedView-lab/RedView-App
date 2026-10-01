import type { ItineraryProject } from '../../types';

/**
 * Brouillon d'une mutation historisée (`commitTraceMutation`).
 *
 * Le projet est cloné en profondeur pour que le mutateur puisse le modifier en
 * place, SAUF les tableaux de points du tracé (`gpxRoute.points` /
 * `originalPoints`), partagés par référence avec l'état précédent. Ce sont
 * l'essentiel du poids d'un projet (dizaines de milliers de points par
 * variante) : les cloner à chaque étape faisait garder 100 copies complètes du
 * projet dans l'historique (+1,2 Go et ~110 ms par étape avec 3 variantes GT20).
 *
 * Contrat (vérifié dans le code) : ces tableaux et leurs points ne sont jamais
 * modifiés en place — toute édition du tracé en produit de nouveaux
 * (projectMutations, cleanGpxGlitches, useItineraryGpxActions…), et un
 * mutateur qui veut les changer remplace `gpxRoute.points` par un nouveau tableau.
 */
export function cloneProjectForMutation(project: ItineraryProject): ItineraryProject {
  const stripped: ItineraryProject = {
    ...project,
    itineraries: project.itineraries.map(stripRoutePoints),
  };
  const draft = structuredClone(stripped);
  draft.itineraries.forEach((itinerary, index) => {
    restoreRoutePoints(itinerary, project.itineraries[index]);
  });
  return draft;
}

type ProjectItinerary = ItineraryProject['itineraries'][number];

/**
 * Même contrat pour une seule variante (`updateActive`) : clone profond à
 * points de tracé partagés. Garder la référence des points évite aussi de
 * réinvalider tout ce qui est mémoïsé dessus (couches, profil, projections)
 * à chaque clic sur un POI.
 */
export function cloneItineraryForMutation(itinerary: ProjectItinerary): ProjectItinerary {
  const draft = structuredClone(stripRoutePoints(itinerary));
  restoreRoutePoints(draft, itinerary);
  return draft;
}

function stripRoutePoints(itinerary: ProjectItinerary): ProjectItinerary {
  return itinerary.gpxRoute
    ? { ...itinerary, gpxRoute: { ...itinerary.gpxRoute, points: [], originalPoints: undefined } }
    : itinerary;
}

function restoreRoutePoints(draft: ProjectItinerary, original: ProjectItinerary | undefined): void {
  const source = original?.gpxRoute;
  if (!draft.gpxRoute || !source) return;
  draft.gpxRoute.points = source.points;
  if (source.originalPoints !== undefined) {
    draft.gpxRoute.originalPoints = source.originalPoints;
  } else {
    delete draft.gpxRoute.originalPoints;
  }
}
