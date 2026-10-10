import { isFootDiscipline, normalizeDiscipline } from '@/shared/lib/discipline';

import type { Itinerary } from '../../types';
import { buildPauseAwareSchedule } from '../schedule';

/** Résultats affichés sous le bouton de calcul du mode Rythme. */
export interface RhythmResultSummary {
  /** Départ → arrivée, pauses comprises. */
  totalSeconds: number;
  /** Temps en déplacement (total − pauses). */
  movingSeconds: number;
  pauseSeconds: number;
  /** Vitesse moyenne en déplacement. */
  movingKmh: number | null;
  /** Allure en déplacement (s/km), course / trail seulement. */
  paceSecondsPerKm: number | null;
}

/**
 * Résumé de la prédiction de l'itinéraire : les lignes s'additionnent
 * (déplacement + pauses = total) et la vitesse est celle du déplacement seul,
 * pondération et profil « vitesse » compris (déjà appliqués au résultat).
 */
export function buildRhythmResultSummary(itinerary: Itinerary): RhythmResultSummary | null {
  const prediction = itinerary.prediction;
  if (!prediction) return null;
  const schedule = buildPauseAwareSchedule(itinerary, prediction);
  const totalSeconds = schedule?.totalDurationSeconds ?? prediction.total_time_s;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  const pauseSeconds = schedule
    ? schedule.pauseSpans.reduce((total, span) => total + span.durationSeconds, 0)
    : 0;
  const movingSeconds = Math.max(0, totalSeconds - pauseSeconds);
  const distanceKm = prediction.total_distance_m / 1000;
  const hasMotion = distanceKm > 0 && movingSeconds > 0 && Number.isFinite(distanceKm);
  const movingKmh = hasMotion ? distanceKm / (movingSeconds / 3600) : null;
  const paceSecondsPerKm = hasMotion && isFootDiscipline(normalizeDiscipline(itinerary.discipline))
    ? movingSeconds / distanceKm
    : null;
  return { totalSeconds, movingSeconds, pauseSeconds, movingKmh, paceSecondsPerKm };
}

/** « 12h05m », « 45m » : même écriture que le bouton de calcul. */
export function formatCompactDuration(totalSeconds: number): string {
  const roundedMinutes = Math.max(0, Math.round(totalSeconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

/** « 24,3 km/h » (fr) / « 24.3 km/h » (en). */
export function formatSpeedKmh(kmh: number, locale: 'fr' | 'en'): string {
  const number = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(kmh);
  return `${number}\u00a0km/h`;
}

/** « 6:05/km ». */
export function formatPacePerKm(secondsPerKm: number): string {
  const rounded = Math.round(secondsPerKm);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}/km`;
}
