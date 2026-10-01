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
    itineraries: project.itineraries.map((itinerary) => (
      itinerary.gpxRoute
        ? { ...itinerary, gpxRoute: { ...itinerary.gpxRoute, points: [], originalPoints: undefined } }
        : itinerary
    )),
  };
  const draft = structuredClone(stripped);
  draft.itineraries.forEach((itinerary, index) => {
    const source = project.itineraries[index]?.gpxRoute;
    if (!itinerary.gpxRoute || !source) return;
    itinerary.gpxRoute.points = source.points;
    if (source.originalPoints !== undefined) {
      itinerary.gpxRoute.originalPoints = source.originalPoints;
    } else {
      delete itinerary.gpxRoute.originalPoints;
    }
  });
  return draft;
}
