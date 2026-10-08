/**
 * Valeurs par défaut du mode expert.
 *
 * `createDefaultExpertState()` renvoie les mêmes valeurs que le `trekking.brf`
 * d'origine : activer la bascule sans rien changer donne le même tracé que le
 * mode simple (aux heuristiques de correspondance du mode simple près).
 */
import { ALL_PARAMETERS } from './parameters';
import type { ExpertProfileState, ParameterValue } from './types';

function createDefaultExpertValues(): Record<string, ParameterValue> {
  const out: Record<string, ParameterValue> = {};
  for (const p of ALL_PARAMETERS) out[p.id] = p.default;
  return out;
}

export function createDefaultExpertState(): ExpertProfileState {
  return {
    enabled: false,
    values: createDefaultExpertValues(),
  };
}
