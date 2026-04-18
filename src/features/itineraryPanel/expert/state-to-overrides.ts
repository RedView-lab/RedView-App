/**
 * Convert an Expert Mode state into BRouter `profile:xxx` URL overrides.
 *
 * We diff the user values against the parameter defaults: only changed
 * values are sent over the wire, keeping URLs short and the cache hit
 * ratio high.
 *
 * Encoding rules + the URL-safe whitelist live in
 * `lib/brouter/param-encoding.ts` so this path and `basicStateToOverrides`
 * can never diverge.
 */
import {
  URL_SAFE_PARAMETER_IDS,
  encodeParamValue,
} from '../lib/brouter/param-encoding';
import { ALL_PARAMETERS } from './parameters';
import type { ExpertProfileState, ParameterValue } from './types';

// Re-exported for backward compatibility with any external import.
export { URL_SAFE_PARAMETER_IDS };

function eq(a: ParameterValue, b: ParameterValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-6;
  }
  return a === b;
}

export function expertStateToOverrides(
  state: ExpertProfileState,
): Record<string, string> {
  if (!state.enabled) return {};
  const out: Record<string, string> = {};
  const skipped: string[] = [];
  for (const param of ALL_PARAMETERS) {
    const v = state.values[param.id];
    if (v === undefined || v === null) continue;
    if (eq(v, param.default)) continue;
    if (!URL_SAFE_PARAMETER_IDS.has(param.id)) {
      skipped.push(param.id);
      continue;
    }
    out[param.id] = encodeParamValue(v);
  }
  if (skipped.length > 0 && typeof console !== 'undefined') {
    console.warn(
      '[BRouter expert] Ces paramètres ne sont pas déclarés comme `assign` global ' +
        'dans trekking.brf — utilisez "Téléverser le profil complet" pour les appliquer:',
      skipped,
    );
  }
  return out;
}
