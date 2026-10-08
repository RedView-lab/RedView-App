/**
 * Discipline sportive d'un itinéraire. Pilote le réseau de routage (profil
 * BRouter vélo ou piéton), le moteur de prédiction (vélo ou course à pied) et
 * l'affichage des vitesses en km/h ou en allure (min/km).
 */
export type SportDiscipline = 'bike' | 'trail' | 'running';

export type FootDiscipline = Exclude<SportDiscipline, 'bike'>;

export function isFootDiscipline(
  discipline: SportDiscipline | null | undefined,
): discipline is FootDiscipline {
  return discipline === 'trail' || discipline === 'running';
}

export function normalizeDiscipline(value: unknown): SportDiscipline {
  return value === 'trail' || value === 'running' ? value : 'bike';
}

/** Discipline pour laquelle une prédiction a été calculée (les anciennes prédictions sont vélo). */
export function resolvePredictionDiscipline(
  prediction: { discipline?: unknown } | null | undefined,
): SportDiscipline {
  return normalizeDiscipline(prediction?.discipline);
}
