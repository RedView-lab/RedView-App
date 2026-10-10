import { describe, expect, it } from 'vitest';
import type { PredictionResult } from '@/features/fitPredictor';

import { createDefaultRhythmState, normalizeItineraryRhythmState } from '../project/defaultState';
import { canonicalJson } from '../project/canonicalJson';
import type { RhythmState } from '../../types';
import {
  TARGET_SPEED_OPTIONS_KMH,
  applyRhythmPaceAdjustments,
  engineRhythmInputs,
  movingSpeedKmh,
  normalizePaceWeightPct,
  normalizeTargetSpeedKmh,
  resolvePresetLevel,
  resolveTargetSpeedKmh,
  stepPaceWeightPct,
  targetSpeedOptionsFor,
} from './pace';

function rhythm(patch: Partial<RhythmState> = {}): RhythmState {
  return { ...createDefaultRhythmState(), ...patch };
}

/** 100 km en 4 h de déplacement (25 km/h), 10 min d'arrêt, deux segments. */
function rawResult(): PredictionResult {
  return {
    total_time_s: 4 * 3600 + 600,
    riding_time_s: 4 * 3600,
    stop_time_s: 600,
    total_distance_m: 100_000,
    avg_speed_kmh: 25,
    elevation_gain_m: 1200,
    elevation_loss_m: 1200,
    total_time_low_s: 13_000,
    total_time_high_s: 16_000,
    segments: [
      { start_distance_m: 0, end_distance_m: 40_000, distance_m: 40_000, elevation_gain_m: 1200, elevation_loss_m: 0, avg_gradient_pct: 3, avg_speed_kmh: 16, time_s: 9000, segment_type: 'climb', vam_mh: 480 },
      { start_distance_m: 40_000, end_distance_m: 100_000, distance_m: 60_000, elevation_gain_m: 0, elevation_loss_m: 1200, avg_gradient_pct: -2, avg_speed_kmh: 40, time_s: 5400, segment_type: 'descent' },
    ],
    points: [
      { distance_m: 0, elevation_m: 100, gradient_pct: 3, predicted_speed_kmh: 16, predicted_power_w: 200, elapsed_time_s: 0, segment_time_s: 0 },
      { distance_m: 40_000, elevation_m: 1300, gradient_pct: -2, predicted_speed_kmh: 40, predicted_power_w: 50, elapsed_time_s: 9000, segment_time_s: 9000, predicted_speed_low_kmh: 36 },
      { distance_m: 100_000, elevation_m: 100, gradient_pct: 0, predicted_speed_kmh: 40, predicted_power_w: 50, elapsed_time_s: 14_400, segment_time_s: 5400 },
    ],
    time_breakdown: { climb_s: 9000, flat_s: 0, descent_s: 5400, walk_s: 0, walk_m: 0, by_limit: { power: 9000, comfort: 5400 } },
    engine_version: 7,
  };
}

describe('liste des vitesses', () => {
  it('va de 8 à 50 km/h par pas de 2', () => {
    expect(TARGET_SPEED_OPTIONS_KMH[0]).toBe(8);
    expect(TARGET_SPEED_OPTIONS_KMH.at(-1)).toBe(50);
    expect(TARGET_SPEED_OPTIONS_KMH).toHaveLength(22);
    expect(TARGET_SPEED_OPTIONS_KMH.every((kmh, i) => i === 0 || kmh - TARGET_SPEED_OPTIONS_KMH[i - 1]! === 2)).toBe(true);
  });

  it('s’arrête à 20 km/h à pied', () => {
    expect(targetSpeedOptionsFor('bike').at(-1)).toBe(50);
    expect(targetSpeedOptionsFor('trail').at(-1)).toBe(20);
    expect(targetSpeedOptionsFor('running')[0]).toBe(8);
  });

  it('ramène une vitesse sur la liste, refuse le reste', () => {
    expect(normalizeTargetSpeedKmh(24)).toBe(24);
    expect(normalizeTargetSpeedKmh(25)).toBe(26);
    expect(normalizeTargetSpeedKmh(50.9)).toBe(50);
    expect(normalizeTargetSpeedKmh(7.5)).toBe(8);
    expect(normalizeTargetSpeedKmh(3)).toBeNull();
    expect(normalizeTargetSpeedKmh(80)).toBeNull();
    expect(normalizeTargetSpeedKmh(Number.NaN)).toBeNull();
    expect(normalizeTargetSpeedKmh('24')).toBeNull();
  });

  it('ne s’applique qu’en profil « vitesse »', () => {
    expect(resolveTargetSpeedKmh(rhythm({ rhythmProfile: 'speed', targetSpeedKmh: 30 }))).toBe(30);
    expect(resolveTargetSpeedKmh(rhythm({ rhythmProfile: 'preset', targetSpeedKmh: 30 }))).toBeNull();
    expect(resolveTargetSpeedKmh(rhythm({ rhythmProfile: 'custom', targetSpeedKmh: 30 }))).toBeNull();
  });

  it('fait tourner le moteur au niveau neutre en profil « vitesse »', () => {
    expect(resolvePresetLevel(rhythm({ rhythmProfile: 'speed', targetSpeedKmh: 30, practiceLevel: 'expert' }))).toBe('intermediaire');
    expect(resolvePresetLevel(rhythm({ rhythmProfile: 'preset', practiceLevel: 'expert' }))).toBe('expert');
    expect(resolvePresetLevel(rhythm({ practiceLevel: null }))).toBe('debutant');
  });
});

describe('pondération', () => {
  it('avance par pas de 5 %, bornée à ±50 %, neutre = absente', () => {
    expect(stepPaceWeightPct(undefined, 1)).toBe(5);
    expect(stepPaceWeightPct(undefined, -1)).toBe(-5);
    expect(stepPaceWeightPct(5, -1)).toBeUndefined();
    expect(stepPaceWeightPct(50, 1)).toBe(50);
    expect(stepPaceWeightPct(-50, -1)).toBe(-50);
    expect(normalizePaceWeightPct(12)).toBe(10);
    expect(normalizePaceWeightPct(-0)).toBeUndefined();
    expect(normalizePaceWeightPct(Infinity)).toBeUndefined();
    expect(Object.is(normalizePaceWeightPct(-2), undefined)).toBe(true);
  });
});

describe('applyRhythmPaceAdjustments', () => {
  it('rend le résultat brut tel quel sans réglage', () => {
    const raw = rawResult();
    expect(applyRhythmPaceAdjustments(raw, rhythm())).toBe(raw);
    // Vitesse imposée hors profil « vitesse » : ignorée.
    expect(applyRhythmPaceAdjustments(raw, rhythm({ targetSpeedKmh: 30 }))).toBe(raw);
  });

  it('+25 % de vitesse : tous les temps de déplacement ÷ 1,25, arrêts et distances inchangés', () => {
    const raw = rawResult();
    const out = applyRhythmPaceAdjustments(raw, rhythm({ paceWeightPct: 25 }));
    expect(out.riding_time_s).toBeCloseTo(11_520);
    expect(out.stop_time_s).toBe(600);
    expect(out.total_time_s).toBeCloseTo(11_520 + 600);
    expect(out.avg_speed_kmh).toBeCloseTo(31.25);
    expect(out.total_time_low_s).toBeCloseTo(10_400);
    expect(out.total_time_high_s).toBeCloseTo(12_800);
    expect(out.total_distance_m).toBe(100_000);
    expect(out.points.map((p) => p.elapsed_time_s)).toEqual([0, 7200, 11_520]);
    expect(out.points[1]!.predicted_speed_kmh).toBeCloseTo(50);
    expect(out.points[1]!.predicted_speed_low_kmh).toBeCloseTo(45);
    expect('predicted_speed_low_kmh' in out.points[0]!).toBe(false);
    expect(out.points[1]!.distance_m).toBe(40_000);
    expect(out.segments[0]!.time_s).toBeCloseTo(7200);
    expect(out.segments[0]!.vam_mh).toBeCloseTo(600);
    expect('vam_mh' in out.segments[1]!).toBe(false);
    expect(out.time_breakdown!.by_limit.comfort).toBeCloseTo(4320);
    expect(out.engine_version).toBe(7);
    // Le brut n'est jamais modifié (il est gardé en cache).
    expect(raw.riding_time_s).toBe(14_400);
    expect(raw.points[2]!.elapsed_time_s).toBe(14_400);
  });

  it('−20 % ralentit', () => {
    const out = applyRhythmPaceAdjustments(rawResult(), rhythm({ paceWeightPct: -20 }));
    expect(out.riding_time_s).toBeCloseTo(18_000);
    expect(movingSpeedKmh(out)).toBeCloseTo(20);
  });

  it('profil « vitesse » : moyenne en déplacement remise à la vitesse choisie, forme du parcours gardée', () => {
    const out = applyRhythmPaceAdjustments(rawResult(), rhythm({ rhythmProfile: 'speed', targetSpeedKmh: 20 }));
    expect(movingSpeedKmh(out)).toBeCloseTo(20);
    expect(out.riding_time_s).toBeCloseTo(18_000);
    // Montée toujours 2,5× plus lente que la descente.
    expect(out.points[1]!.predicted_speed_kmh / out.points[0]!.predicted_speed_kmh).toBeCloseTo(2.5);
  });

  it('profil « vitesse » + pondération : les deux se composent', () => {
    const out = applyRhythmPaceAdjustments(rawResult(), rhythm({ rhythmProfile: 'speed', targetSpeedKmh: 20, paceWeightPct: 10 }));
    expect(movingSpeedKmh(out)).toBeCloseTo(22);
  });

  it('résultat sans déplacement : pondération seule, jamais de NaN', () => {
    const raw = { ...rawResult(), riding_time_s: 0, total_distance_m: 0 };
    expect(applyRhythmPaceAdjustments(raw, rhythm({ rhythmProfile: 'speed', targetSpeedKmh: 20 }))).toBe(raw);
  });
});

describe('estampille et normalisation', () => {
  it('les réglages appliqués après le moteur ne changent pas ses entrées', () => {
    const base = rhythm();
    const tuned = rhythm({ paceWeightPct: 15, targetSpeedKmh: 30 });
    expect(canonicalJson(engineRhythmInputs(tuned))).toBe(canonicalJson(engineRhythmInputs(base)));
    // Passer en profil « vitesse » change le niveau du moteur : nouvelles entrées.
    expect(canonicalJson(engineRhythmInputs(rhythm({ rhythmProfile: 'speed' })))).not.toBe(canonicalJson(engineRhythmInputs(base)));
  });

  it('un rythme ancien reste identique (pas de champ ajouté, même estampille)', () => {
    const stored = createDefaultRhythmState();
    const normalized = normalizeItineraryRhythmState(stored);
    expect(canonicalJson(normalized)).toBe(canonicalJson(stored));
    expect('paceWeightPct' in normalized).toBe(false);
    expect('targetSpeedKmh' in normalized).toBe(false);
  });

  it('valeurs hostiles ramenées dans les bornes', () => {
    const normalized = normalizeItineraryRhythmState({ ...createDefaultRhythmState(), paceWeightPct: 999, targetSpeedKmh: 31 });
    expect(normalized.paceWeightPct).toBe(50);
    expect(normalized.targetSpeedKmh).toBe(32);
  });

  it('profil « vitesse » sans vitesse valable → niveau par défaut', () => {
    const normalized = normalizeItineraryRhythmState({ ...createDefaultRhythmState(), rhythmProfile: 'speed', targetSpeedKmh: 400 });
    expect(normalized.rhythmProfile).toBe('preset');
    expect(normalized.targetSpeedKmh).toBeNull();
    expect(normalizeItineraryRhythmState({ ...createDefaultRhythmState(), rhythmProfile: 'speed', targetSpeedKmh: 24 }).rhythmProfile).toBe('speed');
  });
});
