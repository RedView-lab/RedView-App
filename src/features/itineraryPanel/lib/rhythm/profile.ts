import type { RhythmState } from '../../types';

/** Nombre maximal de .fit de référence par itinéraire. */
export const MAX_FIT_FILES = 20;

/**
 * Niveau transmis aux moteurs en mode "Personalisé" : neutre (facteur 1.0
 * côté vélo, preset intermédiaire côté course), les données de l'utilisateur
 * (.fit, FTP, VMA…) faisant le reste.
 */
export const CUSTOM_PROFILE_LEVEL = 'intermediaire';

/**
 * Vrai quand le profil de rythme est "Personalisé". Les projets enregistrés
 * avant `rhythmProfile` sont considérés personnalisés s'ils portent déjà des
 * données propres au cycliste / coureur.
 */
export function isCustomRhythmProfile(rhythm: RhythmState): boolean {
  if (rhythm.rhythmProfile) return rhythm.rhythmProfile === 'custom';
  return (
    rhythm.usePastActivities
    || isPositive(rhythm.ftp)
    || isPositive(rhythm.systemWeightKg)
    || isPositive(rhythm.vmaKmh)
    || isPositive(rhythm.refRaceTimeS)
    || isPositive(rhythm.runWeightKg)
  );
}

function isPositive(value: number | null | undefined): boolean {
  return typeof value === 'number' && value > 0;
}
