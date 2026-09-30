/**
 * Sport discipline of an itinerary. Drives the routing network (bike vs
 * pedestrian BRouter profile), the prediction engine (cycling vs running)
 * and whether speeds are shown as km/h or as a pace (min/km).
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

/** Discipline a prediction was computed for (older predictions are cycling). */
export function resolvePredictionDiscipline(
  prediction: { discipline?: unknown } | null | undefined,
): SportDiscipline {
  return normalizeDiscipline(prediction?.discipline);
}
