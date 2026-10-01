import {
  describeFitFileProblem,
  type FitFileProblem,
  type FitEngineRejection,
} from '@/features/fitPredictor/lib/fitFileValidation';
import { translateAppText } from '@/shared/i18n';

import type { ItineraryFitRuntime } from './types';

export function buildFitStatusText(runtime: ItineraryFitRuntime | null): string | null {
  if (!runtime) return null;
  const count = runtime.fitFiles.length;
  const countLabel =
    count <= 0 ? null : count === 1 ? '1 fit chargé' : `${count} fit chargés`;
  if (runtime.status === 'error' && runtime.error) {
    return runtime.error;
  }
  if (runtime.status === 'running') {
    const progress = runtime.progress.at(-1);
    return progress ?? (countLabel ? `${countLabel} · calcul en cours...` : 'Calcul en cours...');
  }
  if (runtime.status === 'success') {
    return countLabel
      ? `${countLabel} · prédiction terminée`
      : 'Prédiction terminée';
  }
  if (countLabel) {
    return countLabel;
  }
  return null;
}

/** Message nommant les .fit écartés et leur motif. */
export function buildRejectedFitNotice(
  rejected: ReadonlyArray<{ file: { name: string }; reason: FitFileProblem | FitEngineRejection }>,
): string {
  return translateAppText('Fichiers FIT ignorés : {{list}}', {
    list: rejected
      .map(({ file, reason }) => `${file.name} (${translateAppText(describeFitFileProblem(reason))})`)
      .join(', '),
  });
}
