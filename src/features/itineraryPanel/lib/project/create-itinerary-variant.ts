import { translateAppText } from '@/shared/i18n';
import { ITINERARY_COLORS } from './defaultState';
import type { Itinerary, ItineraryProject } from '../../types';

export interface CreateItineraryVariantResult {
  createdItineraryId: string;
  createdItineraryName: string;
}

/** Couleur de la variante : la teinte suivante de la palette, jamais celle de la source. */
function pickVariantColor(project: ItineraryProject, sourceColor: string): string {
  const normalizedSource = sourceColor.trim().toLowerCase();
  const normalizedPalette = ITINERARY_COLORS.map((color) => color.toLowerCase());
  const sourceIndex = normalizedPalette.indexOf(normalizedSource);
  const startIndex =
    sourceIndex >= 0 ? sourceIndex + 1 : project.itineraries.length % ITINERARY_COLORS.length;

  for (let offset = 0; offset < ITINERARY_COLORS.length; offset += 1) {
    const candidate =
      ITINERARY_COLORS[(startIndex + offset) % ITINERARY_COLORS.length] ?? sourceColor;
    if (candidate.toLowerCase() !== normalizedSource) return candidate;
  }

  return sourceColor;
}

function buildUniqueVariantName(project: ItineraryProject, sourceName: string): string {
  const baseName = translateAppText('Variante de {{name}}', { name: sourceName });
  let nextName = baseName;
  let suffix = 2;
  while (project.itineraries.some((itinerary) => itinerary.name === nextName)) {
    nextName = `${baseName} ${suffix}`;
    suffix += 1;
  }
  return nextName;
}

/**
 * Ajoute à `project` (muté en place) une copie de `sourceId` traitée comme une
 * variante : même tracé que sa source au moment du fork, nouveau nom et nouvelle
 * couleur, rattachée à sa source via `splitRelation` pour apparaître sous elle
 * dans la synthèse et sur le graphe d'analyse.
 *
 * La variante devient l'itinéraire actif. Retourne `null` si la source est absente.
 *
 * `startDistanceKm` est **hérité** de la source : contrairement à un découpage,
 * une variante couvre le même axe kilométrique que son parent, ce qui permet de
 * superposer les deux courbes pour les comparer.
 */
export function addItineraryVariantInPlace(
  project: ItineraryProject,
  sourceId: string,
): CreateItineraryVariantResult | null {
  const source = project.itineraries.find((itinerary) => itinerary.id === sourceId);
  if (!source) return null;

  const createdItineraryId = `it-${Date.now()}-${project.itineraries.length + 1}`;
  const created: Itinerary = structuredClone(source);

  created.id = createdItineraryId;
  created.name = buildUniqueVariantName(project, source.name);
  created.color = pickVariantColor(project, source.color);
  created.visible = true;
  created.analysisVisible = true;
  created.splitRelation = {
    parentItineraryId: source.id,
    rootItineraryId: source.splitRelation?.rootItineraryId ?? source.id,
    startDistanceKm: source.splitRelation?.startDistanceKm ?? 0,
    depth: (source.splitRelation?.depth ?? 0) + 1,
  };

  // Tout ce qui dépend de la géométrie doit être recalculé pour la variante.
  created.prediction = null;
  delete created.routeAudit;
  delete created.pendingRoutePatch;
  delete created.pendingTraceExtension;
  delete created.fitUploads;
  delete created.pendingFitRecompute;

  project.itineraries = [...project.itineraries, created];
  project.activeItineraryId = createdItineraryId;

  return {
    createdItineraryId,
    createdItineraryName: created.name,
  };
}
