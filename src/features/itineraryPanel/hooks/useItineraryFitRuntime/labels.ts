import type { ItineraryFitRuntime } from './types';

export function buildUploadFitLabel(runtime: ItineraryFitRuntime | null): string {
  const count = runtime?.fitFiles.length ?? 0;
  if (count <= 0) return 'Upload .fit';
  return count === 1 ? '1 FIT' : `${count} FIT`;
}

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