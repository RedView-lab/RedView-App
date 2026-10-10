import type { PredictionResult } from '@/features/fitPredictor';
import { isFootDiscipline, type SportDiscipline } from '@/shared/lib/discipline';

import type { RhythmState } from '../../types';

// Réglages de rythme appliqués APRÈS le moteur : profil « vitesse » (moyenne
// en déplacement imposée) et pondération (± % de vitesse). Le moteur garde la
// forme du parcours (plus lent en montée, plus vite en descente) ; seule
// l'échelle de temps change, si bien que la répartition des temps le long du
// tracé reste réaliste.

/** Vitesses du profil « vitesse » : de 8 à 50 km/h, par pas de 2. */
export const TARGET_SPEED_OPTIONS_KMH: readonly number[] = Array.from({ length: 22 }, (_, i) => 8 + i * 2);

/** À pied, la liste s'arrête à une allure de course plausible. */
const FOOT_TARGET_SPEED_MAX_KMH = 20;

/** Niveau du moteur en profil « vitesse » : la forme du parcours, sans biais de niveau. */
const SPEED_PROFILE_LEVEL = 'intermediaire';

export const PACE_WEIGHT_STEP_PCT = 5;
export const PACE_WEIGHT_MIN_PCT = -50;
export const PACE_WEIGHT_MAX_PCT = 50;

/** Champs du rythme que le moteur ne lit pas : un changement ne relance pas le calcul. */
const POST_ENGINE_RHYTHM_KEYS = ['paceWeightPct', 'targetSpeedKmh'] as const satisfies readonly (keyof RhythmState)[];

export function targetSpeedOptionsFor(discipline: SportDiscipline): readonly number[] {
  return isFootDiscipline(discipline)
    ? TARGET_SPEED_OPTIONS_KMH.filter((kmh) => kmh <= FOOT_TARGET_SPEED_MAX_KMH)
    : TARGET_SPEED_OPTIONS_KMH;
}

/** Vitesse de la liste la plus proche, ou null hors de [8, 50] km/h. */
export function normalizeTargetSpeedKmh(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const first = TARGET_SPEED_OPTIONS_KMH[0]!;
  const last = TARGET_SPEED_OPTIONS_KMH[TARGET_SPEED_OPTIONS_KMH.length - 1]!;
  if (value < first - 1 || value > last + 1) return null;
  const snapped = first + Math.round((value - first) / 2) * 2;
  return Math.min(last, Math.max(first, snapped));
}

/** Pondération bornée, au pas de 5 % ; 0 (neutre) = absente. */
export function normalizePaceWeightPct(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const snapped = Math.round(value / PACE_WEIGHT_STEP_PCT) * PACE_WEIGHT_STEP_PCT;
  const clamped = Math.min(PACE_WEIGHT_MAX_PCT, Math.max(PACE_WEIGHT_MIN_PCT, snapped));
  // `+ 0` : jamais de -0 dans le document.
  return clamped === 0 ? undefined : clamped + 0;
}

/**
 * Pondération après un clic sur − (direction -1) ou + (direction 1). Neutre =
 * `undefined` : le rythme redevient identique à celui d'avant (même estampille,
 * aucune prédiction recalculée).
 */
export function stepPaceWeightPct(current: number | null | undefined, direction: 1 | -1): number | undefined {
  return normalizePaceWeightPct((normalizePaceWeightPct(current) ?? 0) + direction * PACE_WEIGHT_STEP_PCT);
}

function isSpeedRhythmProfile(rhythm: Pick<RhythmState, 'rhythmProfile'>): boolean {
  return rhythm.rhythmProfile === 'speed';
}

/** Vitesse imposée en déplacement, seulement en profil « vitesse ». */
export function resolveTargetSpeedKmh(rhythm: Pick<RhythmState, 'rhythmProfile' | 'targetSpeedKmh'>): number | null {
  return isSpeedRhythmProfile(rhythm) ? normalizeTargetSpeedKmh(rhythm.targetSpeedKmh) : null;
}

/** Niveau passé aux moteurs hors profil Personnalisé (niveau choisi, ou neutre en profil « vitesse »). */
export function resolvePresetLevel(rhythm: Pick<RhythmState, 'rhythmProfile' | 'practiceLevel'>): string {
  return isSpeedRhythmProfile(rhythm) ? SPEED_PROFILE_LEVEL : rhythm.practiceLevel ?? 'debutant';
}

/** Rythme tel que le moteur le lit : clé du cache des résultats bruts. */
export function engineRhythmInputs(rhythm: RhythmState): Partial<RhythmState> {
  const copy: Partial<RhythmState> = { ...rhythm };
  for (const key of POST_ENGINE_RHYTHM_KEYS) delete copy[key];
  return copy;
}

/** Vitesse moyenne en déplacement (km/h) d'une prédiction, ou null. */
export function movingSpeedKmh(prediction: Pick<PredictionResult, 'total_distance_m' | 'riding_time_s'>): number | null {
  const { total_distance_m: distanceM, riding_time_s: movingS } = prediction;
  if (!(distanceM > 0) || !(movingS > 0)) return null;
  const kmh = (distanceM / movingS) * 3.6;
  return Number.isFinite(kmh) ? kmh : null;
}

/**
 * Facteur de vitesse à appliquer au résultat brut du moteur : vitesse imposée
 * du profil « vitesse » rapportée à la moyenne du moteur, puis pondération.
 * 1 = résultat inchangé.
 */
function paceSpeedFactor(rhythm: RhythmState, raw: Pick<PredictionResult, 'total_distance_m' | 'riding_time_s'>): number {
  let factor = 1;
  const target = resolveTargetSpeedKmh(rhythm);
  const rawKmh = movingSpeedKmh(raw);
  if (target !== null && rawKmh !== null) factor = target / rawKmh;
  const weight = normalizePaceWeightPct(rhythm.paceWeightPct) ?? 0;
  factor *= 1 + weight / 100;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * Applique le profil « vitesse » et la pondération au résultat brut du moteur :
 * vitesses × k, temps de déplacement ÷ k, partout où le résultat en porte
 * (points, segments, fourchette, ventilation). Le temps d'arrêt, la distance
 * et le dénivelé ne changent pas ; le modèle du cycliste (puissance, CdA…)
 * reste celui du moteur. Résultat brut rendu tel quel quand k = 1.
 */
export function applyRhythmPaceAdjustments(raw: PredictionResult, rhythm: RhythmState): PredictionResult {
  const k = paceSpeedFactor(rhythm, raw);
  if (k === 1) return raw;
  const time = (seconds: number) => seconds / k;

  const ridingS = time(raw.riding_time_s);
  const result: PredictionResult = {
    ...raw,
    riding_time_s: ridingS,
    // Ce qui n'est pas du déplacement (arrêts) garde sa durée.
    total_time_s: raw.total_time_s - raw.riding_time_s + ridingS,
    avg_speed_kmh: raw.avg_speed_kmh * k,
    points: raw.points.map((point) => {
      const scaled = {
        ...point,
        predicted_speed_kmh: point.predicted_speed_kmh * k,
        elapsed_time_s: time(point.elapsed_time_s),
        segment_time_s: time(point.segment_time_s),
      };
      if (point.predicted_speed_low_kmh !== undefined) scaled.predicted_speed_low_kmh = point.predicted_speed_low_kmh * k;
      if (point.predicted_speed_high_kmh !== undefined) scaled.predicted_speed_high_kmh = point.predicted_speed_high_kmh * k;
      return scaled;
    }),
    segments: raw.segments.map((segment) => {
      const scaled = { ...segment, avg_speed_kmh: segment.avg_speed_kmh * k, time_s: time(segment.time_s) };
      if (segment.vam_mh !== undefined) scaled.vam_mh = segment.vam_mh * k;
      return scaled;
    }),
  };
  if (raw.total_time_low_s !== undefined) result.total_time_low_s = time(raw.total_time_low_s);
  if (raw.total_time_high_s !== undefined) result.total_time_high_s = time(raw.total_time_high_s);
  if (raw.time_breakdown) {
    const breakdown = raw.time_breakdown;
    const scaled = {
      ...breakdown,
      climb_s: time(breakdown.climb_s),
      flat_s: time(breakdown.flat_s),
      descent_s: time(breakdown.descent_s),
      walk_s: time(breakdown.walk_s),
      by_limit: Object.fromEntries(Object.entries(breakdown.by_limit).map(([key, s]) => [key, time(s)])),
    };
    if (breakdown.corner_loss_s !== undefined) scaled.corner_loss_s = time(breakdown.corner_loss_s);
    if (breakdown.way_loss_s !== undefined) scaled.way_loss_s = time(breakdown.way_loss_s);
    if (breakdown.physio_loss_s !== undefined) scaled.physio_loss_s = time(breakdown.physio_loss_s);
    result.time_breakdown = scaled;
  }
  return result;
}
