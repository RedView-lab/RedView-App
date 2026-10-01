import { CYCLING_ENGINE_VERSION } from '@/features/fitPredictor';
import type { CyclingCalibration, PredictionResult } from '@/features/fitPredictor';
import type { FitEngineRequestOptions, createFitPredictionEngine } from '@/features/fitPredictor/engine/api';
import { resolvePredictionDiscipline } from '@/shared/lib/discipline';

import type { Itinerary } from '../../types';
import {
  buildCyclingConfig,
  buildCyclingRiderSpec,
  buildCyclingRouteInput,
  resolveCyclingGeometry,
} from '../../lib/schedule';
import { fitFileKey } from './files';

type FitPredictionEngine = ReturnType<typeof createFitPredictionEngine>;

/**
 * Calibrations .fit (moteur vélo v2) par jeu de fichiers, prior saisi et
 * version du moteur. On garde la promesse : deux calculs rapprochés (édition
 * du tracé pendant la calibration) n'en lancent qu'une.
 */
export type CyclingCalibrationCache = Map<string, Promise<CyclingCalibration>>;

const MAX_CACHED_CALIBRATIONS = 8;

function calibrationKey(itinerary: Itinerary, fitFiles: readonly File[]): string {
  return [
    CYCLING_ENGINE_VERSION,
    JSON.stringify(buildCyclingRiderSpec(itinerary.rhythm)),
    ...fitFiles.map(fitFileKey).sort(),
  ].join('|');
}

async function resolveCalibration(
  engine: FitPredictionEngine,
  itinerary: Itinerary,
  fitFiles: readonly File[],
  cache: CyclingCalibrationCache,
  onProgress: (message: string) => void,
  options: FitEngineRequestOptions,
): Promise<CyclingCalibration | null> {
  if (fitFiles.length === 0) return null;
  const key = calibrationKey(itinerary, fitFiles);
  let pending = cache.get(key);
  if (!pending) {
    pending = engine.calibrateCycling(fitFiles, { rider: buildCyclingRiderSpec(itinerary.rhythm) }, onProgress, options);
    cache.set(key, pending);
    // Échec ou abandon (calcul remplacé) : ne pas garder une promesse rejetée.
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
    while (cache.size > MAX_CACHED_CALIBRATIONS) {
      cache.delete(cache.keys().next().value as string);
    }
  }
  return pending;
}

/**
 * Prédiction vélo v2 : calibration sur les .fit du profil Personnalisé (mise
 * en cache), sinon préréglage de niveau, puis temps de déplacement sur le
 * tracé complet. Le moteur ignore les pauses : le planning de l'app les ajoute
 * ensuite. Le rapport de calibration accompagne le résultat.
 */
export async function predictCyclingItinerary(
  engine: FitPredictionEngine,
  itinerary: Itinerary,
  fitFiles: readonly File[],
  cache: CyclingCalibrationCache,
  onProgress: (message: string) => void,
  options: FitEngineRequestOptions,
): Promise<PredictionResult> {
  const calibration = await resolveCalibration(engine, itinerary, fitFiles, cache, onProgress, options);
  const result = await engine.predictCycling(
    buildCyclingRouteInput(itinerary),
    buildCyclingConfig(itinerary.rhythm, { calibration, geometry: resolveCyclingGeometry(itinerary) }),
    onProgress,
    options,
  );
  return calibration ? { ...result, calibration: calibration.report } : result;
}

/** Prédiction vélo persistée par un moteur plus ancien : à recalculer. */
export function isCyclingPredictionOutdated(prediction: PredictionResult | null | undefined): boolean {
  if (!prediction || resolvePredictionDiscipline(prediction) !== 'bike') return false;
  return (prediction.engine_version ?? 0) < CYCLING_ENGINE_VERSION;
}
