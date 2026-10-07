import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '../../types';

/** itineraryId → dernière prédiction réussie. */
export type PredictionMap = Record<string, PredictionResult | null>;

/** Prédictions enregistrées sur les itinéraires du projet. */
export function projectPredictions(itineraries: readonly Itinerary[] | undefined): PredictionMap {
  const predictions: PredictionMap = {};
  for (const it of itineraries ?? []) {
    if (it.prediction) predictions[it.id] = it.prediction;
  }
  return predictions;
}

/**
 * Le projet fait foi : quand la prédiction stockée d'un itinéraire change
 * entre `previous` et `next` (undo / redo, édition du tracé qui l'invalide,
 * résultat async), la valeur exposée suit ; un itinéraire supprimé perd la
 * sienne. Une prédiction que le projet n'a pas changée reste telle quelle.
 * Renvoie `current` lui-même quand rien ne change.
 */
export function followProjectPredictions(
  current: PredictionMap,
  previous: readonly Itinerary[] | undefined,
  next: readonly Itinerary[],
): PredictionMap {
  const before = new Map((previous ?? []).map((it) => [it.id, it.prediction ?? null]));
  const present = new Set<string>();
  let result = current;
  const edit = () => {
    if (result === current) result = { ...current };
    return result;
  };
  for (const it of next) {
    present.add(it.id);
    const value = it.prediction ?? null;
    if (before.has(it.id) && before.get(it.id) === value) continue;
    if ((current[it.id] ?? null) === value) continue;
    if (value) edit()[it.id] = value;
    else if (it.id in current) delete edit()[it.id];
  }
  for (const id of Object.keys(current)) {
    if (!present.has(id)) delete edit()[id];
  }
  return result;
}
